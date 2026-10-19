import { Pool } from 'pg';
import { join } from 'path';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    _pool = new Pool({ connectionString });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL environment variable is not set');

  const { runner } = await import('node-pg-migrate');

  await runner({
    databaseUrl,
    dir: join(__dirname, 'db', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    // v9 fails immediately when another process holds the advisory lock.
    // Waiting matches the previous behavior so a second replica can start
    // while the first is still migrating.
    advisoryLockMode: 'wait',
    log: () => {},
  });
}
