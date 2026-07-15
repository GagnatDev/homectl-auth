/**
 * The forward-auth sidecar as an Express app.
 *
 * Per incoming request the app:
 *   1. reads its encrypted session cookie;
 *   2. if there is no session, either 302s an HTML navigation to central login
 *      or answers 401 to an XHR;
 *   3. handles the OAuth callback and logout on their own paths;
 *   4. refreshes the access token in-cluster when it is close to expiry;
 *   5. strips spoofable inbound headers and injects a verified identity, then
 *      proxies the request to the app container.
 *
 * No request body is parsed globally: bodies must stream through to the
 * upstream untouched, so only cookies are read (from the raw header).
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import pinoHttp from 'pino-http';
import type { JWTVerifyGetKey } from 'jose';
import type { ProxyConfig } from './config';
import { createAuthClient, type AuthClient } from './auth-client';
import { open, seal, type Session } from './session';
import {
  signState,
  verifyState,
  newNonce,
  STATE_COOKIE_NAME,
  STATE_COOKIE_MAX_AGE_MS,
} from './state';
import { sanitizeReturnTo } from './return-to';
import { logger } from './logger';

export type CreateProxyAppOptions = {
  config: ProxyConfig;
  /** Inject a pre-built auth client (tests). */
  authClient?: AuthClient;
  /** JWKS provider passed to the default auth client (tests). */
  jwksProvider?: JWTVerifyGetKey;
};

const IDENTITY_HEADER_PREFIX = 'x-homectl-';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function isHtmlRequest(req: Request): boolean {
  return (req.headers['accept'] ?? '').includes('text/html');
}

/**
 * Remove every header a client could use to impersonate a user. This runs on
 * *every* proxied request, before we inject our own trusted identity — it is
 * the guarantee the upstream app relies on.
 */
function stripInboundIdentity(req: Request): void {
  delete req.headers['authorization'];
  for (const name of Object.keys(req.headers)) {
    if (name.toLowerCase().startsWith(IDENTITY_HEADER_PREFIX)) {
      delete req.headers[name];
    }
  }
}

function injectIdentity(
  req: Request,
  identity: { accessToken?: string; sub: string; email: string; role: string | null },
): void {
  if (identity.accessToken) {
    req.headers['authorization'] = `Bearer ${identity.accessToken}`;
  }
  req.headers['x-homectl-user'] = identity.sub;
  req.headers['x-homectl-email'] = identity.email;
  if (identity.role) {
    req.headers['x-homectl-role'] = identity.role;
  }
}

export function createProxyApp(opts: CreateProxyAppOptions): Express {
  const { config } = opts;
  const auth = opts.authClient ?? createAuthClient(config, opts.jwksProvider);
  const app = express();
  app.disable('x-powered-by');

  if (process.env['NODE_ENV'] !== 'test') {
    app.use(pinoHttp({ logger }));
  }

  const cookieBaseOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax' as const,
    path: '/',
  };

  function setSession(res: Response, session: Session): void {
    res.cookie(config.sessionCookieName, seal(session, config.cookieKey), cookieBaseOptions);
  }

  function clearSession(res: Response): void {
    res.clearCookie(config.sessionCookieName, { path: '/' });
  }

  // ── Health / readiness ──────────────────────────────────────────────────
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/readyz', async (_req, res) => {
    try {
      await auth.checkJwks();
      res.json({ status: 'ready' });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'readiness check failed');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // ── Dev-only bypass ───────────────────────────────────────────────────────
  // With DEV_FAKE_IDENTITY set (never in production — enforced in loadConfig)
  // the sidecar skips the OAuth flow entirely and injects a fixed identity, so
  // an app runs without a cluster. No real JWT is available, so only the
  // X-Homectl-* headers are injected (no Authorization bearer).
  if (config.devIdentity) {
    const dev = config.devIdentity;
    logger.warn(
      { sub: dev.sub },
      'DEV_FAKE_IDENTITY is set — authentication is BYPASSED. This must never run in production.',
    );
    app.use((req, _res, next) => {
      stripInboundIdentity(req);
      injectIdentity(req, { sub: dev.sub, email: dev.email, role: dev.role });
      next();
    });
    app.use(createUpstreamProxy(config));
    return app;
  }

  // ── OAuth callback ────────────────────────────────────────────────────────
  app.get(config.callbackPath, async (req, res) => {
    const cookies = parseCookies(req.headers['cookie']);
    const statePayload = verifyState(cookies[STATE_COOKIE_NAME], config.cookieKey);

    // Single-use: clear the state cookie regardless of outcome.
    res.clearCookie(STATE_COOKIE_NAME, { path: '/' });

    if (!statePayload) {
      logger.warn('callback rejected: missing or invalid state cookie');
      res.status(400).json({ error: 'invalid_state' });
      return;
    }

    const { code, state } = req.query as Record<string, string | undefined>;
    if (!state || state !== statePayload.nonce) {
      logger.warn('callback rejected: state mismatch');
      res.status(400).json({ error: 'state_mismatch' });
      return;
    }
    if (!code) {
      res.status(400).json({ error: 'missing_code' });
      return;
    }

    try {
      const accessToken = await auth.exchangeCode(code);
      const claims = await auth.verifyAccessToken(accessToken);

      // First refresh token: reuse the browser's per-app refresh cookie
      // (homectl_refresh_<clientId>, set by homectl-auth on Domain=.homectl.no).
      // The sidecar owns rotation from here on via /internal/refresh.
      const refreshToken = cookies[`homectl_refresh_${config.clientId}`] ?? '';
      if (!refreshToken) {
        logger.warn(
          'no homectl_refresh cookie on callback; session cannot be refreshed until re-login',
        );
      }

      setSession(res, {
        refreshToken,
        accessToken,
        accessExp: claims.exp,
        sub: claims.sub,
        email: claims.email,
        role: claims.role,
      });

      logger.info({ sub: claims.sub }, 'login callback succeeded');
      res.redirect(302, sanitizeReturnTo(statePayload.returnTo));
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'login callback failed');
      res.status(502).json({ error: 'auth_upstream_error' });
    }
  });

  // ── Logout ──────────────────────────────────────────────────────────────
  // Clears the sidecar session so the browser is logged out of this app. The
  // central homectl-auth SSO session is intentionally left intact (that is what
  // preserves SSO across apps); a full central logout is a separate action.
  app.post(config.logoutPath, (_req, res) => {
    clearSession(res);
    res.redirect(302, '/');
  });

  // ── Public static files ───────────────────────────────────────────────────
  // Static files are public by default so browsers can load an app's assets
  // before authentication. Never forward client-supplied identity headers.
  if (config.bypassStaticAuth) {
    app.use((req, _res, next) => {
      if (req.path.startsWith('/static/')) {
        stripInboundIdentity(req);
      }
      next();
    });
  }

  // ── Authenticate + inject ─────────────────────────────────────────────────
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (config.bypassStaticAuth && req.path.startsWith('/static/')) {
      next();
      return;
    }

    const cookies = parseCookies(req.headers['cookie']);
    let session = open(cookies[config.sessionCookieName], config.cookieKey);

    if (!session) {
      startLogin(req, res);
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (session.accessExp - now < config.refreshSkewSeconds) {
      try {
        const refreshed = await auth.refresh(session.refreshToken);
        const claims = await auth.verifyAccessToken(refreshed.accessToken);
        session = {
          refreshToken: refreshed.refreshToken,
          accessToken: refreshed.accessToken,
          accessExp: claims.exp,
          sub: claims.sub,
          email: claims.email,
          role: claims.role,
        };
        setSession(res, session);
        logger.info({ sub: claims.sub }, 'access token refreshed');
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'refresh failed; forcing re-login');
        clearSession(res);
        startLogin(req, res);
        return;
      }
    }

    stripInboundIdentity(req);
    injectIdentity(req, {
      accessToken: session.accessToken,
      sub: session.sub,
      email: session.email,
      role: session.role,
    });
    next();
  });

  app.use(createUpstreamProxy(config));

  function startLogin(req: Request, res: Response): void {
    // Never bounce an XHR/API request — let the SPA handle a 401 itself.
    if (!isHtmlRequest(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const nonce = newNonce();
    const returnTo = sanitizeReturnTo(req.originalUrl);
    res.cookie(STATE_COOKIE_NAME, signState({ nonce, returnTo }, config.cookieKey), {
      ...cookieBaseOptions,
      maxAge: STATE_COOKIE_MAX_AGE_MS,
    });

    const authorizeUrl = new URL(`${config.publicAuthUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', config.clientId);
    authorizeUrl.searchParams.set('redirect_uri', config.redirectUri);
    authorizeUrl.searchParams.set('state', nonce);

    res.redirect(302, authorizeUrl.toString());
  }

  return app;
}

function createUpstreamProxy(config: ProxyConfig) {
  return createProxyMiddleware({
    target: config.upstream,
    changeOrigin: false,
    // Bodies stream through untouched; we only mutate headers upstream.
    logLevel: 'silent',
    onError: (err, _req, res) => {
      logger.error({ err: err.message }, 'upstream proxy error');
      const response = res as Response;
      if (!response.headersSent) {
        response.status(502).json({ error: 'bad_gateway' });
      }
    },
  });
}
