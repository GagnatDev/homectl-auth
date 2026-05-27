import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { POSTGRES_URI_FILE } from './vitest.constants';

let container: StartedPostgreSqlContainer;

export async function setup(): Promise<void> {
  console.log('[global-setup] Starting PostgreSQL container...');
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const uri = container.getConnectionUri();
  writeFileSync(POSTGRES_URI_FILE, uri, 'utf-8');
  console.log('[global-setup] PostgreSQL ready at', uri.replace(/:[^:@]+@/, ':***@'));

  // Run all migrations once before any tests
  const client = new Client({ connectionString: uri });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const migrationsDir = join(__dirname, 'src', 'db', 'migrations');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rows } = await client.query<{ filename: string }>(
        'SELECT filename FROM _migrations WHERE filename = $1',
        [file],
      );
      if (rows.length === 0) {
        const sql = readFileSync(join(migrationsDir, file), 'utf-8');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        console.log(`[global-setup] Migration applied: ${file}`);
      }
    }
  } finally {
    await client.end();
  }
}

export async function teardown(): Promise<void> {
  await container?.stop();
  console.log('[global-setup] PostgreSQL container stopped');
}
