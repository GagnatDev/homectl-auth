import { Pool } from 'pg';
import { join } from 'path';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env['POSTGRES_URL'];
    if (!connectionString) {
      throw new Error('POSTGRES_URL environment variable is not set');
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
  const databaseUrl = process.env['POSTGRES_URL'];
  if (!databaseUrl) throw new Error('POSTGRES_URL environment variable is not set');

  const { runner } = await import('node-pg-migrate');

  await runner({
    databaseUrl,
    dir: join(__dirname, 'db', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}
