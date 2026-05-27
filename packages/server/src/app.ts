import express, { type Express } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { logger } from './logger';
import { jwksRouter } from './routes/jwks.router';

export function createApp(): Express {
  const app = express();

  // HTTP request logging — suppressed during tests to keep output clean
  if (process.env['NODE_ENV'] !== 'test') {
    app.use(pinoHttp({ logger }));
  }

  app.use(helmet());
  app.use(express.json());
  app.use(cookieParser());

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ── JWKS ──────────────────────────────────────────────────────────────────
  app.use(jwksRouter);

  return app;
}
