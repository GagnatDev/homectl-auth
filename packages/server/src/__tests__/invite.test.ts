import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getPool } from '../db';
import { createApp } from '../app';
import { generateTestKeys, resetKeys, signAccessToken } from '../modules/token/token.service';
import {
  setupTestAppConfig,
  TEST_APP_ID,
  TEST_APP,
  createTestUser,
  createTestUserWithAccess,
  truncateTables,
} from './helpers/test-app-config';
import { createAdminInvite } from '../modules/invite/invite.service';
import { findUserByEmail } from '../modules/user/user.repository';
import { findAccess } from '../modules/app-access/app-access.repository';

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

// Admin user used for invite creation
async function makeAdminUser() {
  return createTestUser({ email: 'admin@example.com', username: 'admin', isAdmin: true });
}

// ── Admin invite ───────────────────────────────────────────────────────────

describe('Invite — admin flow', () => {
  it('creates a new user and grants app access on redemption', async () => {
    const admin = await makeAdminUser();
    const { token } = await createAdminInvite({
      email: 'newuser@example.com',
      appGrants: [{ appId: TEST_APP_ID, role: 'viewer' }],
      createdByUserId: admin.id,
    });

    const res = await request(app)
      .post('/invite')
      .type('form')
      .send({ token, username: 'newuser', password: 'Password123!' });

    expect(res.status).toBe(302);

    const user = await findUserByEmail('newuser@example.com');
    expect(user).toBeTruthy();

    const access = await findAccess(user!.id, TEST_APP_ID);
    expect(access?.role).toBe('viewer');
  });

  it('adds app access to an existing account without creating a duplicate user', async () => {
    const admin = await makeAdminUser();
    const existing = await createTestUser({ email: 'existing@example.com' });

    const { token } = await createAdminInvite({
      email: 'existing@example.com',
      appGrants: [{ appId: TEST_APP_ID, role: 'editor' }],
      createdByUserId: admin.id,
    });

    const res = await request(app)
      .post('/invite')
      .type('form')
      .send({ token, username: 'newname', password: 'Password123!' });

    expect(res.status).toBe(302);

    // No duplicate user created
    const { rows } = await getPool().query(
      'SELECT count(*) FROM homectl_auth.users WHERE email = $1',
      ['existing@example.com'],
    );
    expect(parseInt(rows[0]['count'] as string)).toBe(1);

    // App access granted to existing account
    const access = await findAccess(existing.id, TEST_APP_ID);
    expect(access?.role).toBe('editor');
  });

  it('rejects redemption of an expired invite', async () => {
    const admin = await makeAdminUser();
    const { token } = await createAdminInvite({
      email: 'exp@example.com',
      appGrants: [],
      createdByUserId: admin.id,
    });

    // Manually expire it
    const { createHash } = await import('crypto');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await getPool().query(
      'UPDATE homectl_auth.invite_tokens SET expires_at = NOW() - INTERVAL \'1 hour\' WHERE token_hash = $1',
      [tokenHash],
    );

    const res = await request(app)
      .post('/invite')
      .type('form')
      .send({ token, username: 'expuser', password: 'Password123!' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('expired');
  });

  it('rejects a second redemption of the same invite (single-use)', async () => {
    const admin = await makeAdminUser();
    const { token } = await createAdminInvite({
      email: 'reuse@example.com',
      appGrants: [],
      createdByUserId: admin.id,
    });

    await request(app)
      .post('/invite')
      .type('form')
      .send({ token, username: 'reuseuser', password: 'Password123!' });

    const res2 = await request(app)
      .post('/invite')
      .type('form')
      .send({ token, username: 'reuseuser2', password: 'Password123!' });

    expect(res2.status).toBe(400);
  });

  it('rejects redemption when email belongs to a different user than expected (race)', async () => {
    const admin = await makeAdminUser();

    // The invite was created targeting an existing account (user A).
    const userA = await createTestUser({ email: 'raceuser@example.com', username: 'userA' });
    const { token } = await createAdminInvite({
      email: 'raceuser@example.com',
      appGrants: [{ appId: TEST_APP_ID, role: 'viewer' }],
      createdByUserId: admin.id,
    });
    // Verify expected_user_id was set to userA.id
    const { createHash } = await import('crypto');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const { rows } = await getPool().query(
      'SELECT expected_user_id FROM homectl_auth.invite_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    expect(rows[0]['expected_user_id']).toBe(userA.id);

    // Race: a second user (user B) somehow now has the same email
    // We simulate this by pointing expected_user_id at a *different* real user
    const userB = await createTestUser({ email: 'other@example.com', username: 'userB' });
    await getPool().query(
      'UPDATE homectl_auth.invite_tokens SET expected_user_id = $1 WHERE token_hash = $2',
      [userB.id, tokenHash], // expected is userB, but email belongs to userA
    );

    const res = await request(app)
      .post('/invite')
      .type('form')
      .send({ token, username: 'raceuser', password: 'Password123!' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('claimed');
  });
});

// ── Delegated (privileged app user) invite ─────────────────────────────────

describe('Invite — delegated flow via POST /api/invites', () => {
  async function makeInviterToken(role: string): Promise<string> {
    const user = await createTestUserWithAccess(TEST_APP_ID, role);
    return signAccessToken({
      sub: user.id,
      email: user.email,
      isAdmin: false,
      apps: [{ appId: TEST_APP_ID, role }],
      clientId: TEST_APP_ID,
    });
  }

  it('succeeds when invitee rank < inviter rank', async () => {
    // editor (rank 2) inviting viewer (rank 1)
    const token = await makeInviterToken('editor');

    const res = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'newbie@example.com', appId: TEST_APP_ID, role: 'viewer' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('token');
  });

  it('rejects when invitee rank >= inviter rank (equal)', async () => {
    // editor (rank 2) trying to invite editor (rank 2)
    const token = await makeInviterToken('editor');

    const res = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'newbie@example.com', appId: TEST_APP_ID, role: 'editor' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('RANK_TOO_HIGH');
  });

  it('rejects when invitee rank > inviter rank', async () => {
    // viewer (rank 1) trying to invite admin (rank 3)
    const token = await makeInviterToken('viewer');

    const res = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'newbie@example.com', appId: TEST_APP_ID, role: 'admin' });

    expect(res.status).toBe(403);
  });

  it('rejects when inviter has no access to the target app', async () => {
    // User with no app access
    const user = await createTestUser();
    const token = await signAccessToken({
      sub: user.id,
      email: user.email,
      isAdmin: false,
      apps: [],
      clientId: TEST_APP_ID,
    });

    const res = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'newbie@example.com', appId: TEST_APP_ID, role: 'viewer' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NO_INVITER_ACCESS');
  });

  it('returns 401 with no Bearer token', async () => {
    const res = await request(app)
      .post('/api/invites')
      .send({ email: 'x@example.com', appId: TEST_APP_ID, role: 'viewer' });

    expect(res.status).toBe(401);
  });
});
