import express, { type Express } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { join } from 'path';
import { logger } from './logger';
import { jwksRouter } from './routes/jwks.router';
import { authorizeRouter } from './routes/authorize.router';
import { tokenRouter } from './routes/token.router';
import { sessionRouter } from './routes/session.router';
import { inviteRouter } from './routes/invite.router';
import { resetPasswordRouter } from './routes/reset-password.router';
import { adminRouter } from './routes/admin/admin.router';
import { githubOauthRouter } from './modules/github-oauth/github-oauth.router';

export function createApp(): Express {
  const app = express();

  // HTTP request logging — suppressed during tests to keep output clean
  if (process.env['NODE_ENV'] !== 'test') {
    app.use(pinoHttp({ logger }));
  }

  app.use(helmet());
  app.use(express.json());
  // Admin GUI forms (native and htmx) post urlencoded bodies. extended:true is
  // required so the invite form's bracket notation (appGrants[0][appId]) parses
  // into a nested array.
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // ── Templating ────────────────────────────────────────────────────────────
  app.set('view engine', 'ejs');
  app.set('views', join(__dirname, 'views'));

  // ── Static assets ───────────────────────────────────────────────────────────
  // Vendored client libraries (e.g. htmx) are served from our own origin so the
  // strict CSP (script-src 'self') needs no CDN exception. Public — no auth guard.
  app.use('/static', express.static(join(__dirname, 'public'), { maxAge: '1d' }));

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
  app.use(inviteRouter);
  app.use(resetPasswordRouter);
  // GitHub OAuth login routes must precede adminRouter so /admin/login and
  // /admin/github/callback are handled before adminRouter's requireAdmin guard.
  app.use(githubOauthRouter);
  app.use(adminRouter);

  return app;
}
