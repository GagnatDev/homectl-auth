/**
 * @gagnatdev/homectl-auth-client/server
 *
 * Server-side Express integration for homectl-auth.
 *
 * Usage:
 *   import { createAuthClient } from '@gagnatdev/homectl-auth-client/server';
 *
 *   const { authMiddleware, callbackHandler, logoutHandler } = createAuthClient({
 *     authServiceUrl: 'https://auth.homectl.no',
 *     // Optional — route token exchange + JWKS via in-cluster service discovery:
 *     internalAuthServiceUrl: 'http://homectl-auth.homectl.svc.cluster.local',
 *     clientId: 'travel-journal',
 *     clientSecret: process.env.CLIENT_SECRET!,
 *     appBaseUrl: 'https://reisedagbok.homectl.no',
 *   });
 *
 *   app.use(authMiddleware);
 *   app.get('/auth/callback', callbackHandler);
 *   app.post('/auth/logout', logoutHandler);
 */

import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import { randomBytes, createHmac } from 'crypto';

// ── Types ──────────────────────────────────────────────────────────────────

export type AuthClientOptions = {
  /**
   * Public base URL of the auth service, e.g. https://auth.homectl.no.
   * Used for browser-facing flows (the /authorize redirect and the logout
   * page) and as the expected JWT `iss` claim — it must match the issuer the
   * auth service signs tokens with, regardless of how this app reaches it.
   */
  authServiceUrl: string;
  /**
   * Base URL for server-to-server calls (token exchange and, by default, the
   * JWKS fetch). Set this to an internal service-discovery address — e.g.
   * http://homectl-auth.homectl.svc.cluster.local — to keep backend traffic
   * in-cluster. Defaults to authServiceUrl. Browser redirects and issuer
   * verification always use authServiceUrl.
   */
  internalAuthServiceUrl?: string;
  /** JWKS URL — defaults to ${internalAuthServiceUrl ?? authServiceUrl}/.well-known/jwks.json */
  jwksUrl?: string;
  /** The app's client_id as registered in the auth service config */
  clientId: string;
  /** The app's client_secret (read from env in consuming app) */
  clientSecret: string;
  /** The public-facing base URL of the consuming app, e.g. https://reisedagbok.homectl.no */
  appBaseUrl: string;
  /** Path where the auth callback is handled — default /auth/callback */
  callbackPath?: string;
  /**
   * Optional: override the JWKS key provider (for testing with local key pairs).
   * Receives a JWTVerifyGetKey-compatible function (e.g. createLocalJWKSet output).
   */
  _jwksProvider?: Parameters<typeof jwtVerify>[1];
};

export type AuthUser = {
  id: string;
  email: string;
  isAdmin: boolean;
  /** The user's role in this specific app (from apps[] claim matching clientId) */
  role: string | null;
};

// Extend Express Request with user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ── Refresh cookie detection ─────────────────────────────────────────────────

/** Server-side per-app refresh cookie name — matches homectl-auth's `homectl_refresh_<clientId>`. */
const REFRESH_COOKIE_PREFIX = 'homectl_refresh_';

/**
 * Whether the request carries this app's refresh cookie. Reads cookie-parser's
 * `req.cookies` when present, otherwise parses the raw `Cookie` header so the
 * guardrail works even if cookie-parser is not mounted.
 */
function hasRefreshCookie(req: Request, clientId: string): boolean {
  const name = `${REFRESH_COOKIE_PREFIX}${clientId}`;
  const parsed = (req as Request & { cookies?: Record<string, string> }).cookies;
  if (parsed && typeof parsed[name] === 'string' && parsed[name].length > 0) {
    return true;
  }
  const raw = req.headers['cookie'];
  if (!raw) return false;
  return raw.split(';').some((c) => c.trimStart().startsWith(`${name}=`));
}

// ── State cookie ───────────────────────────────────────────────────────────

const STATE_COOKIE_NAME = 'homectl_auth_state';
const STATE_COOKIE_MAX_AGE = 10 * 60 * 1000; // 10 minutes

type StateCookiePayload = {
  nonce: string;
  originalUrl: string;
};

function signStateCookie(payload: StateCookiePayload, secret: string): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64');
  const sig = createHmac('sha256', secret).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

function verifyStateCookie(
  value: string,
  secret: string,
): StateCookiePayload | null {
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expectedSig = createHmac('sha256', secret).update(b64!).digest('hex');
  if (sig !== expectedSig) return null;
  try {
    return JSON.parse(Buffer.from(b64!, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export type AuthClientResult = {
  authMiddleware: RequestHandler;
  callbackHandler: RequestHandler;
  logoutHandler: RequestHandler;
};

export function createAuthClient(options: AuthClientOptions): AuthClientResult {
  const {
    authServiceUrl,
    clientId,
    clientSecret,
    appBaseUrl,
    callbackPath = '/auth/callback',
  } = options;

  // Server-to-server calls (token exchange, JWKS) go to the internal URL when
  // one is configured; everything the browser touches stays on authServiceUrl.
  const internalUrl = options.internalAuthServiceUrl ?? authServiceUrl;
  const jwksUrl = options.jwksUrl ?? `${internalUrl}/.well-known/jwks.json`;
  const JWKS = options._jwksProvider ?? createRemoteJWKSet(new URL(jwksUrl));
  const redirectUri = `${appBaseUrl}${callbackPath}`;

  function isHtmlRequest(req: Request): boolean {
    const accept = req.headers['accept'] ?? '';
    return accept.includes('text/html');
  }

  // ── authMiddleware ─────────────────────────────────────────────────────

  const authMiddleware: RequestHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token) {
      handleUnauthenticated(req, res, next, 'unauthorized');
      return;
    }

    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: authServiceUrl,
        audience: clientId,
        algorithms: ['RS256'],
      });

      req.user = extractUser(payload, clientId);
      next();
    } catch {
      handleUnauthenticated(req, res, next, 'invalid_token');
    }
  };

  /**
   * Respond to a request that carries no valid access token.
   *
   * API/XHR requests get a hard 401 — the browser helper's authedFetch will
   * bootstrap a token and retry.
   *
   * Top-level HTML navigations are the trap: a browser *never* attaches a
   * Bearer header to a navigation, and the access token lives in JS memory
   * (fetched by bootstrap() only after the shell loads). A naive redirect to
   * /authorize therefore loops forever once the user is logged in:
   *   page → /authorize → (SSO) → back to page → still no header → /authorize → …
   *
   * Guardrail: if the request already carries this app's refresh cookie the
   * user has a live session, so let the request through and let the SPA
   * bootstrap its token. Only redirect to /authorize on a genuine first visit
   * (no session cookie). Gating only your API routes is still the correct
   * wiring — this is a safety net, not a licence to put authMiddleware in front
   * of HTML.
   */
  function handleUnauthenticated(
    req: Request,
    res: Response,
    next: NextFunction,
    apiError: string,
  ): void {
    if (!isHtmlRequest(req)) {
      res.status(401).json({ error: apiError });
      return;
    }
    if (hasRefreshCookie(req, clientId)) {
      next();
      return;
    }
    redirectToLogin(req, res);
  }

  function redirectToLogin(req: Request, res: Response): void {
    const nonce = randomBytes(16).toString('hex');
    const originalUrl = req.originalUrl || '/';
    const stateCookieValue = signStateCookie({ nonce, originalUrl }, clientSecret);

    res.cookie(STATE_COOKIE_NAME, stateCookieValue, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'lax',
      maxAge: STATE_COOKIE_MAX_AGE,
    });

    const authorizeUrl = new URL(`${authServiceUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', nonce);

    res.redirect(302, authorizeUrl.toString());
  }

  // ── callbackHandler ────────────────────────────────────────────────────

  const callbackHandler: RequestHandler = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const { code, state } = req.query as Record<string, string>;

    const stateCookie = (req.cookies as Record<string, string>)[STATE_COOKIE_NAME];
    if (!stateCookie) {
      res.status(400).json({ error: 'missing_state_cookie' });
      return;
    }

    const statePayload = verifyStateCookie(stateCookie, clientSecret);
    if (!statePayload) {
      res.status(400).json({ error: 'invalid_state_cookie' });
      return;
    }

    // Clear state cookie (single-use)
    res.clearCookie(STATE_COOKIE_NAME);

    if (state !== statePayload.nonce) {
      res.status(400).json({ error: 'state_mismatch' });
      return;
    }

    if (!code) {
      res.status(400).json({ error: 'missing_code' });
      return;
    }

    // Exchange code for token (server-to-server)
    let tokenRes: Response;
    try {
      const response = await fetch(`${internalUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });

      if (!response.ok) {
        res.status(400).json({ error: 'token_exchange_failed' });
        return;
      }
      // Token is discarded — refresh cookie was set on auth.homectl.no
      // Browser helper will bootstrap access token via /refresh on page load
    } catch {
      res.status(500).json({ error: 'token_exchange_error' });
      return;
    }

    // Redirect to the original URL
    const redirectTo = statePayload.originalUrl || '/';
    res.redirect(302, redirectTo);
  };

  // ── logoutHandler ──────────────────────────────────────────────────────

  const logoutHandler: RequestHandler = (_req: Request, res: Response): void => {
    // Render a page that fires a cross-origin POST to the auth service /logout,
    // then redirects back to the app's home.
    const logoutHtml = `<!DOCTYPE html>
<html>
<head><title>Logging out…</title></head>
<body>
<script>
(async function() {
  try {
    await fetch('${authServiceUrl}/logout', {
      method: 'POST',
      credentials: 'include',
    });
  } catch (_) {}
  window.location.href = '${appBaseUrl}/';
})();
</script>
</body>
</html>`;
    res.type('html').send(logoutHtml);
  };

  return { authMiddleware, callbackHandler, logoutHandler };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractUser(payload: JWTPayload, clientId: string): AuthUser {
  const apps = (payload['apps'] as Array<{ appId: string; role: string }>) ?? [];
  const appEntry = apps.find((a) => a.appId === clientId);

  return {
    id: payload['sub'] as string,
    email: payload['email'] as string,
    isAdmin: (payload['isAdmin'] as boolean) ?? false,
    role: appEntry?.role ?? null,
  };
}
