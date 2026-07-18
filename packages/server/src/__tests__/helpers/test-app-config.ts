/**
 * Test helpers: inject app config + create test users with known secrets.
 */

import { setAppsConfig, type AppConfig } from '../../config/apps';
import { createUser, type User } from '../../modules/user/user.repository';
import { hashPassword } from '../../modules/user/password.service';
import { grantAccess } from '../../modules/app-access/app-access.repository';
import { getPool } from '../../db';

// ── Canonical test app config ──────────────────────────────────────────────

export const TEST_APP_ID = 'test-app';
export const TEST_CLIENT_SECRET = 'super-secret-client-key';
export const TEST_CLIENT_SECRET_ENV = 'TEST_APP_CLIENT_SECRET';

export const TEST_APP: AppConfig = {
  id: TEST_APP_ID,
  name: 'Test App',
  clientSecretEnv: TEST_CLIENT_SECRET_ENV,
  allowedRedirectUris: ['https://test-app.homectl.no/auth/callback'],
  allowedOrigins: ['https://test-app.homectl.no'],
  roles: [
    { name: 'admin', rank: 3 },
    { name: 'editor', rank: 2 },
    { name: 'viewer', rank: 1 },
  ],
};

export async function setupTestAppConfig(): Promise<void> {
  process.env[TEST_CLIENT_SECRET_ENV] = TEST_CLIENT_SECRET;
  setAppsConfig([TEST_APP]);
}

// ── Test user factory ──────────────────────────────────────────────────────

export type TestUser = User & { plainPassword: string };

export async function createTestUser(
  overrides: {
    email?: string;
    username?: string;
    password?: string;
    isAdmin?: boolean;
  } = {},
): Promise<TestUser> {
  const email = overrides.email ?? `test-${Date.now()}@example.com`;
  const username = overrides.username ?? `user_${Date.now()}`;
  const password = overrides.password ?? 'TestPass123!';
  const passwordHash = await hashPassword(password);

  const user = await createUser({
    email,
    username,
    passwordHash,
    isAdmin: overrides.isAdmin ?? false,
  });

  return { ...user, plainPassword: password };
}

export async function createTestUserWithAccess(
  appId: string,
  role: string,
  overrides: Parameters<typeof createTestUser>[0] = {},
): Promise<TestUser> {
  const user = await createTestUser(overrides);
  await grantAccess(user.id, appId, role);
  return user;
}

// ── DB cleanup ─────────────────────────────────────────────────────────────

export async function truncateTables(): Promise<void> {
  const pool = getPool();
  // Truncate in dependency order (children first)
  await pool.query(`
    TRUNCATE TABLE
      homectl_auth.activity_events,
      homectl_auth.authorization_codes,
      homectl_auth.sessions,
      homectl_auth.invite_tokens,
      homectl_auth.password_reset_tokens,
      homectl_auth.app_access,
      homectl_auth.users
    RESTART IDENTITY CASCADE
  `);
}
