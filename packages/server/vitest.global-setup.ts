import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { runner } from 'node-pg-migrate';
import { POSTGRES_URI_FILE } from './vitest.constants';

let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  // TEST_DATABASE_URL points the suite at an already-running Postgres (for
  // environments without Docker). Default: spin up a testcontainers instance.
  let uri = process.env['TEST_DATABASE_URL'];
  if (uri) {
    console.log('[global-setup] Using external PostgreSQL from TEST_DATABASE_URL');
  } else {
    console.log('[global-setup] Starting PostgreSQL container...');
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    uri = container.getConnectionUri();
    console.log('[global-setup] PostgreSQL ready at', uri.replace(/:[^:@]+@/, ':***@'));
  }

  writeFileSync(POSTGRES_URI_FILE, uri, 'utf-8');

  await runner({
    databaseUrl: uri,
    dir: join(__dirname, 'src', 'db', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: (msg) => console.log(`[global-setup] ${msg}`),
  });
}

export async function teardown(): Promise<void> {
  if (container) {
    await container.stop();
    console.log('[global-setup] PostgreSQL container stopped');
  }
}
