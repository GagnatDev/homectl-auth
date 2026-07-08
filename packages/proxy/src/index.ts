import { loadConfig } from './config';
import { createProxyApp } from './app';
import { logger } from './logger';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Fatal misconfiguration — print the full list of problems and exit.
    console.error((err as Error).message);
    process.exit(1);
  }

  const app = createProxyApp({ config });
  const server = app.listen(config.listenPort, () => {
    logger.info(
      { port: config.listenPort, upstream: config.upstream, clientId: config.clientId },
      'homectl-auth-proxy started',
    );
  });

  const shutdown = () => {
    logger.info('shutting down');
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
