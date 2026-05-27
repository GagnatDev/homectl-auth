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

export function createApp(): Express {
  const app = express();

  // HTTP request logging — suppressed during tests to keep output clean
  if (process.env['NODE_ENV'] !== 'test') {
    app.use(pinoHttp({ logger }));
  }

  app.use(helmet());
  app.use(express.json());
  app.use(cookieParser());

  // ── Templating ────────────────────────────────────────────────────────────
  app.set('view engine', 'ejs');
  app.set('views', join(__dirname, 'views'));

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

  return app;
}
