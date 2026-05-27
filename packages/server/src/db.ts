import { Pool, Client } from 'pg';
import { readFileSync, readdirSync } from 'fs';
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

/**
 * Applies any unapplied SQL migration files from src/db/migrations/ in order.
 * Safe to call multiple times — already-applied migrations are skipped.
 */
export async function runMigrations(): Promise<void> {
  const connectionString = process.env['POSTGRES_URL'];
  if (!connectionString) {
    throw new Error('POSTGRES_URL environment variable is not set');
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const migrationsDir = join(__dirname, 'db', 'migrations');
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
      }
    }
  } finally {
    await client.end();
  }
}
