import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { getPool } from '../db';
import { createApp } from '../app';
import { generateTestKeys, resetKeys, signAccessToken } from '../modules/token/token.service';
import { setAppsConfig, type AppConfig } from '../config/apps';
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
    // Single-app invite: redirected straight to the app (first allowed origin).
    expect(res.headers['location']).toBe('https://test-app.homectl.no');

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

    expect(res.status).toBe(302);
    const url = new URL(res.headers['location'] as string, 'http://localhost');
    expect(url.pathname).toBe('/invite');
    expect(url.searchParams.get('error')).toBe('EXPIRED_TOKEN');
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

    expect(res2.status).toBe(302);
    const url = new URL(res2.headers['location'] as string, 'http://localhost');
    // The consumed invite token is removed, so reuse reads as invalid.
    expect(url.searchParams.get('error')).toBe('INVALID_TOKEN');
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

    expect(res.status).toBe(302);
    const url = new URL(res.headers['location'] as string, 'http://localhost');
    expect(url.searchParams.get('error')).toBe('EMAIL_RACE');
  });
});

// ── Post-signup redirect ───────────────────────────────────────────────────

describe('Invite — post-signup redirect', () => {
  const SECOND_APP: AppConfig = {
    id: 'second-app',
    name: 'Second App',
    clientSecretEnv: 'SECOND_APP_CLIENT_SECRET',
    allowedRedirectUris: ['https://second-app.homectl.no/auth/callback'],
    allowedOrigins: ['https://second-app.homectl.no'],
    roles: [{ name: 'viewer', rank: 1 }],
  };

  afterEach(async () => {
    // Restore the canonical single-app config for other test files.
    await setupTestAppConfig();
  });

  async function redeem(appGrants: { appId: string; role: string }[]) {
    const admin = await makeAdminUser();
    const { token } = await createAdminInvite({
      email: 'redirect@example.com',
      appGrants,
      createdByUserId: admin.id,
    });
    return request(app)
      .post('/invite')
      .type('form')
      .send({ token, username: 'redirectuser', password: 'Password123!' });
  }

  it('prefers an explicit landingUrl over the first allowed origin', async () => {
    setAppsConfig([{ ...TEST_APP, landingUrl: 'https://test-app.homectl.no/welcome' }]);

    const res = await redeem([{ appId: TEST_APP_ID, role: 'viewer' }]);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://test-app.homectl.no/welcome');
  });

  it('redirects to the app chooser when the invite granted multiple apps', async () => {
    setAppsConfig([TEST_APP, SECOND_APP]);

    const res = await redeem([
      { appId: TEST_APP_ID, role: 'viewer' },
      { appId: SECOND_APP.id, role: 'viewer' },
    ]);

    expect(res.status).toBe(302);
    const url = new URL(res.headers['location'] as string, 'http://localhost');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('invited')).toBe('1');
    expect(url.searchParams.get('apps')).toBe(`${TEST_APP_ID},${SECOND_APP.id}`);
  });

  it('redirects straight to the only navigable app when the others have no landing URL', async () => {
    setAppsConfig([TEST_APP, { ...SECOND_APP, allowedOrigins: [] }]);

    const res = await redeem([
      { appId: TEST_APP_ID, role: 'viewer' },
      { appId: SECOND_APP.id, role: 'viewer' },
    ]);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://test-app.homectl.no');
  });

  it('falls back to the plain confirmation page for a grant-less invite', async () => {
    const res = await redeem([]);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/?invited=1');
  });

  it('falls back to the plain confirmation page when no granted app has a landing URL', async () => {
    setAppsConfig([{ ...TEST_APP, allowedOrigins: [] }]);

    const res = await redeem([{ appId: TEST_APP_ID, role: 'viewer' }]);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/?invited=1');
  });
});

// ── SSO session on activation ──────────────────────────────────────────────

describe('Invite — SSO session on activation', () => {
  function extractCookie(res: request.Response, name: string): string | undefined {
    const raw = res.headers['set-cookie'];
    const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const found = list.find((c) => c.startsWith(`${name}=`));
    return found?.split(';')[0]!.split('=').slice(1).join('=');
  }

  it('sets the SSO cookie when redemption creates a new account', async () => {
    const admin = await makeAdminUser();
    const { token } = await createAdminInvite({
      email: 'sso-new@example.com',
      appGrants: [{ appId: TEST_APP_ID, role: 'viewer' }],
      createdByUserId: admin.id,
    });

    const res = await request(app)
      .post('/invite')
      .type('form')
      .send({ token, username: 'ssonew', password: 'Password123!' });

    expect(res.status).toBe(302);
    const sso = extractCookie(res, 'homectl_sso');
    const user = await findUserByEmail('sso-new@example.com');
    expect(sso).toBe(user!.id);
  });

  it('does NOT set the SSO cookie when the invite targets an existing account', async () => {
    const admin = await makeAdminUser();
    await createTestUser({ email: 'sso-existing@example.com' });
    const { token } = await createAdminInvite({
      email: 'sso-existing@example.com',
      appGrants: [{ appId: TEST_APP_ID, role: 'viewer' }],
      createdByUserId: admin.id,
    });

    const res = await request(app)
      .post('/invite')
      .type('form')
      .send({ token, username: 'ssoexisting', password: 'Password123!' });

    expect(res.status).toBe(302);
    expect(extractCookie(res, 'homectl_sso')).toBeUndefined();
  });

  it('lets a freshly activated user enter the app via /authorize without a login form', async () => {
    const admin = await makeAdminUser();
    const { token } = await createAdminInvite({
      email: 'sso-flow@example.com',
      appGrants: [{ appId: TEST_APP_ID, role: 'viewer' }],
      createdByUserId: admin.id,
    });

    const redeemRes = await request(app)
      .post('/invite')
      .type('form')
      .send({ token, username: 'ssoflow', password: 'Password123!' });
    const sso = extractCookie(redeemRes, 'homectl_sso');
    expect(sso).toBeTruthy();

    // The app the user landed on starts its OAuth flow; the SSO short-circuit
    // must redirect straight back to the callback with a code.
    const redirectUri = TEST_APP.allowedRedirectUris[0]!;
    const authRes = await request(app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: TEST_APP_ID,
        redirect_uri: redirectUri,
        state: 'xyz',
      })
      .set('Cookie', `homectl_sso=${sso}`);

    expect(authRes.status).toBe(302);
    const url = new URL(authRes.headers['location'] as string);
    expect(`${url.origin}${url.pathname}`).toBe(redirectUri);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('xyz');
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
