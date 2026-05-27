import { runMigrations, closePool } from './db';
import { createApp } from './app';
import { logger } from './logger';
import { startCleanupJob } from './jobs/cleanup';

async function main(): Promise<void> {
  const port = parseInt(process.env['PORT'] ?? '3000', 10);

  logger.info('Running database migrations...');
  await runMigrations();
  logger.info('Migrations complete');
  startCleanupJob();

  const app = createApp();
  const server = app.listen(port, () => {
    logger.info({ port }, 'homectl-auth server started');
  });

  const shutdown = () => {
    logger.info('Shutting down...');
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
