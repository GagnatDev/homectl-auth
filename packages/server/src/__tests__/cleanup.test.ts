import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getPool } from '../db';
import { generateTestKeys, resetKeys } from '../modules/token/token.service';
import {
  setupTestAppConfig,
  createTestUser,
  truncateTables,
} from './helpers/test-app-config';
import { runCleanup } from '../jobs/cleanup';

beforeAll(async () => {
  await generateTestKeys();
  await setupTestAppConfig();
});

beforeEach(async () => {
  await truncateTables();
});

afterAll(() => {
  resetKeys();
});

// ── Cleanup job ────────────────────────────────────────────────────────────

describe('runCleanup()', () => {
  it('deletes rows with expires_at > 1 day ago from authorization_codes', async () => {
    const pool = getPool();
    const user = await createTestUser();

    // Insert one row that expired 25h ago (should be deleted)
    await pool.query(
      `INSERT INTO homectl_auth.authorization_codes
         (code_hash, client_id, user_id, redirect_uri, expires_at)
       VALUES ('stale_code_hash', 'test-app', $1, 'https://example.com/callback',
               NOW() - INTERVAL '25 hours')`,
      [user.id],
    );

    // Insert one row that expired 23h ago (within grace period — should NOT be deleted)
    await pool.query(
      `INSERT INTO homectl_auth.authorization_codes
         (code_hash, client_id, user_id, redirect_uri, expires_at)
       VALUES ('fresh_code_hash', 'test-app', $1, 'https://example.com/callback',
               NOW() - INTERVAL '23 hours')`,
      [user.id],
    );

    await runCleanup();

    const { rows } = await pool.query(
      'SELECT code_hash FROM homectl_auth.authorization_codes ORDER BY code_hash',
    );
    const hashes = rows.map((r: Record<string, unknown>) => r['code_hash']);
    expect(hashes).not.toContain('stale_code_hash');
    expect(hashes).toContain('fresh_code_hash');
  });

  it('deletes expired sessions older than 1 day', async () => {
    const pool = getPool();
    const user = await createTestUser();

    await pool.query(
      `INSERT INTO homectl_auth.sessions (token_hash, user_id, client_id, expires_at)
       VALUES ('stale_session', $1, 'test-app', NOW() - INTERVAL '25 hours')`,
      [user.id],
    );

    await pool.query(
      `INSERT INTO homectl_auth.sessions (token_hash, user_id, client_id, expires_at)
       VALUES ('fresh_session', $1, 'test-app', NOW() + INTERVAL '30 days')`,
      [user.id],
    );

    await runCleanup();

    const { rows } = await pool.query(
      'SELECT token_hash FROM homectl_auth.sessions',
    );
    const hashes = rows.map((r: Record<string, unknown>) => r['token_hash']);
    expect(hashes).not.toContain('stale_session');
    expect(hashes).toContain('fresh_session');
  });

  it('does not delete rows that expired within the 1-day grace period', async () => {
    const pool = getPool();
    const user = await createTestUser();

    // Expired 1 minute ago (very fresh expiry)
    await pool.query(
      `INSERT INTO homectl_auth.sessions (token_hash, user_id, client_id, expires_at)
       VALUES ('just_expired', $1, 'test-app', NOW() - INTERVAL '1 minute')`,
      [user.id],
    );

    await runCleanup();

    const { rows } = await pool.query(
      "SELECT token_hash FROM homectl_auth.sessions WHERE token_hash = 'just_expired'",
    );
    expect(rows.length).toBe(1);
  });
});
