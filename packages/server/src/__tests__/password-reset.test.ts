import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getPool } from '../db';
import { createApp } from '../app';
import { generateTestKeys, resetKeys, verifyAccessToken, signAccessToken } from '../modules/token/token.service';
import {
  setupTestAppConfig,
  TEST_APP_ID,
  createTestUser,
  createTestUserWithAccess,
  truncateTables,
} from './helpers/test-app-config';
import { createResetToken } from '../modules/password-reset/password-reset.service';
import { createSession } from '../modules/session/session.service';
import { findUserById } from '../modules/user/user.repository';

const app = createApp();

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

// ── Password Reset Module ──────────────────────────────────────────────────

describe('Password reset', () => {
  it('successfully resets password and deletes all sessions', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'viewer');

    // Create an active session for this user
    await createSession(user.id, TEST_APP_ID);

    const { token } = await createResetToken({ userId: user.id });

    // Verify sessions exist before reset
    const { rows: sessionsBefore } = await getPool().query(
      'SELECT count(*) FROM homectl_auth.sessions WHERE user_id = $1',
      [user.id],
    );
    expect(parseInt(sessionsBefore[0]['count'] as string)).toBe(1);

    const res = await request(app)
      .post('/reset-password')
      .type('form')
      .send({ token, password: 'NewPassword456!' });

    expect(res.status).toBe(302);

    // All sessions deleted
    const { rows: sessionsAfter } = await getPool().query(
      'SELECT count(*) FROM homectl_auth.sessions WHERE user_id = $1',
      [user.id],
    );
    expect(parseInt(sessionsAfter[0]['count'] as string)).toBe(0);
  });

  it('a JWT issued before reset remains valid until expiry (stateless — documented limitation)', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'viewer');

    // Mint an access token
    const jwtBefore = await signAccessToken({
      sub: user.id,
      email: user.email,
      isAdmin: false,
      apps: [{ appId: TEST_APP_ID, role: 'viewer' }],
      clientId: TEST_APP_ID,
    });

    // Do the reset
    const { token } = await createResetToken({ userId: user.id });
    await request(app)
      .post('/reset-password')
      .type('form')
      .send({ token, password: 'NewPassword456!' });

    // Old JWT still verifies (stateless, no denylist)
    const payload = await verifyAccessToken(jwtBefore, TEST_APP_ID);
    expect(payload.sub).toBe(user.id);
  });

  it('rejects an expired reset token', async () => {
    const user = await createTestUser();
    const { token } = await createResetToken({ userId: user.id });

    // Manually expire
    const { createHash } = await import('crypto');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await getPool().query(
      'UPDATE homectl_auth.password_reset_tokens SET expires_at = NOW() - INTERVAL \'1 hour\' WHERE token_hash = $1',
      [tokenHash],
    );

    const res = await request(app)
      .post('/reset-password')
      .type('form')
      .send({ token, password: 'NewPassword456!' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('expired');
  });

  it('rejects a second use of the same reset token', async () => {
    const user = await createTestUser();
    const { token } = await createResetToken({ userId: user.id });

    await request(app)
      .post('/reset-password')
      .type('form')
      .send({ token, password: 'NewPassword456!' });

    const res2 = await request(app)
      .post('/reset-password')
      .type('form')
      .send({ token, password: 'AnotherPassword789!' });

    expect(res2.status).toBe(400);
  });

  it('GET /reset-password?token=… renders the form', async () => {
    const res = await request(app).get('/reset-password').query({ token: 'sometoken' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Reset Password');
  });

  it('GET /reset-password without token returns 400', async () => {
    const res = await request(app).get('/reset-password');
    expect(res.status).toBe(400);
  });
});
