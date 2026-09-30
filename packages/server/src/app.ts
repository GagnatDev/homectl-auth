import express, { type Express } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { logger } from './logger';
import { getAllApps } from './config/apps';
import { jwksRouter } from './routes/jwks.router';
import { authorizeRouter } from './routes/authorize.router';
import { tokenRouter } from './routes/token.router';
import { sessionRouter } from './routes/session.router';
import { internalRouter } from './routes/internal.router';
import { internalUsersRouter } from './routes/internal-users.router';
import { inviteRouter } from './routes/invite.router';
import { resetPasswordRouter } from './routes/reset-password.router';
import { adminRouter } from './routes/admin/admin.router';
import { githubOauthRouter } from './modules/github-oauth/github-oauth.router';
import { serveShell, WEB_DIST_DIR } from './web-shell';

/**
 * Space-separated list of origins for the CSP `form-action` directive, derived
 * from the registered apps' `allowedRedirectUris` — i.e. the actual 302 targets
 * of the login form. Deriving from the redirect URIs (not `allowedOrigins`)
 * keeps the directive aligned with where this service actually redirects, so a
 * future app whose redirect_uri lives on a different host than its origin still
 * works. Returns `'self'` when no extra origins are configured, so the directive
 * never emits an empty token. Malformed URIs are skipped.
 */
function formActionOrigins(): string {
  try {
    const origins = new Set<string>();
    for (const app of getAllApps()) {
      for (const uri of app.allowedRedirectUris) {
        try {
          origins.add(new URL(uri).origin);
        } catch {
          // skip malformed redirect URIs rather than break the whole directive
        }
      }
    }
    return origins.size > 0 ? Array.from(origins).join(' ') : "'self'";
  } catch {
    return "'self'";
  }
}

export function createApp(): Express {
  const app = express();

  // HTTP request logging — suppressed during tests to keep output clean
  if (process.env['NODE_ENV'] !== 'test') {
    app.use(pinoHttp({ logger }));
  }

  // This service is an OAuth provider: after a credential POST to /login it 302s
  // to a consuming app's redirect_uri on a *different* origin. helmet's default
  // CSP sets `form-action 'self'`, which the browser evaluates across the whole
  // redirect chain and would block that cross-origin submit. Allow form actions
  // to the registered apps' origins as well. Resolved lazily per-request so the
  // header always reflects the current app config (and so app creation does not
  // depend on the apps config being loaded yet). useDefaults stays on, so this
  // only overrides the form-action directive and keeps the rest of helmet's CSP.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'form-action': ["'self'", () => formActionOrigins()],
          // The React SPA relies on Radix UI, which sets inline `style="…"`
          // attributes (animation/positioning state). helmet's default
          // `style-src 'self'` would block those, so allow inline styles.
          // Scripts stay `'self'` — the Vite bundle has no inline JS.
          'style-src': ["'self'", "'unsafe-inline'"],
        },
      },
    }),
  );
  app.use(express.json());
  // Admin GUI forms (native and htmx) post urlencoded bodies. extended:true is
  // required so the invite form's bracket notation (appGrants[0][appId]) parses
  // into a nested array.
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // ── Static assets ───────────────────────────────────────────────────────────
  // The React SPA bundle (index.html + hashed /assets/*) plus the PWA public
  // files copied to the bundle root (manifest.webmanifest, sw.js, icons,
  // favicon). Served from our own origin so the strict CSP (script-src 'self')
  // needs no exception, and mounted ahead of every auth-gated router so PWA
  // install works before sign-in. Public — serving only files that exist;
  // unmatched paths fall through to the routers and the shell catch-all below.
  //
  // Only Vite's content-hashed /assets/* bundles are cached immutably. The
  // shell, service worker, manifest and icons have stable names, so they must
  // revalidate — otherwise a deploy or a new service worker would never reach
  // clients holding a year-long immutable copy.
  app.use(
    express.static(WEB_DIST_DIR, {
      index: false,
      setHeaders: (res, filePath) => {
        if (/[\\/]assets[\\/]/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ── JWKS ──────────────────────────────────────────────────────────────────
  app.use(jwksRouter);

  // ── Auth flow ─────────────────────────────────────────────────────────────
  app.use(authorizeRouter);
  app.use(tokenRouter);
  app.use(sessionRouter);
  // Server-to-server, client-authenticated endpoints for in-cluster callers
  // (e.g. an auth sidecar). Reached via the ClusterIP Service, not the ingress.
  app.use(internalRouter);
  app.use(internalUsersRouter);
  app.use(inviteRouter);
  app.use(resetPasswordRouter);
  // GitHub OAuth login routes must precede adminRouter so /admin/login and
  // /admin/github/callback are handled before adminRouter's requireAdmin guard.
  app.use(githubOauthRouter);
  app.use(adminRouter);

  // ── SPA shell fallback ──────────────────────────────────────────────────────
  // Any unmatched GET that a browser made (Accept: text/html) gets the SPA shell
  // so React Router can resolve deep links (e.g. /admin/users/:id). API, token,
  // and well-known paths never fall here — they 404 as JSON instead.
  app.get('*', (req, res) => {
    const isApiPath =
      /^\/(admin\/api|api|token|refresh|logout|health|internal|\.well-known)(\/|$)/.test(req.path);
    if (isApiPath || !req.accepts('html')) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    serveShell(res);
  });

  return app;
}
