import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { runner } from 'node-pg-migrate';
import { POSTGRES_URI_FILE } from './vitest.constants';

let container: StartedPostgreSqlContainer;

export async function setup(): Promise<void> {
  console.log('[global-setup] Starting PostgreSQL container...');
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const uri = container.getConnectionUri();
  writeFileSync(POSTGRES_URI_FILE, uri, 'utf-8');
  console.log('[global-setup] PostgreSQL ready at', uri.replace(/:[^:@]+@/, ':***@'));

  await runner({
    databaseUrl: uri,
    dir: join(__dirname, 'src', 'db', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: (msg) => console.log(`[global-setup] ${msg}`),
  });
}

export async function teardown(): Promise<void> {
  await container?.stop();
  console.log('[global-setup] PostgreSQL container stopped');
}
