import pino from 'pino';

export const logger = pino({
  name: 'homectl-auth-proxy',
  level: process.env['LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'test' ? 'silent' : 'info'),
});
