import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createApp } from '../app';
import {
  generateTestKeys,
  resetKeys,
  signAccessToken,
} from '../modules/token/token.service';
import {
  setupTestAppConfig,
  TEST_APP_ID,
  TEST_APP,
  createTestUser,
  createTestUserWithAccess,
  truncateTables,
} from './helpers/test-app-config';
import { getPool } from '../db';
import { runCleanup } from '../jobs/cleanup';

const REDIRECT_URI = TEST_APP.allowedRedirectUris[0]!;
const APP_ORIGIN = TEST_APP.allowedOrigins[0]!;

const app = createApp();

beforeAll(async () => {
  await generateTestKeys();
  await setupTestAppConfig();
});

beforeEach(async () => {
  await truncateTables();
});

afterEach(() => {
  delete process.env['ACTIVITY_RETENTION_DAYS'];
});

afterAll(() => {
  resetKeys();
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function login(username: string, password: string) {
  const res = await request(app).post('/login').type('form').send({
    client_id: TEST_APP_ID,
    redirect_uri: REDIRECT_URI,
    state: '',
    username,
    password,
  });
  expect(res.status).toBe(302);
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []) as string[];
}

function extractCookie(cookies: string[], name: string): string | undefined {
  const found = cookies.find((c) => c.startsWith(`${name}=`));
  if (!found) return undefined;
  return found.split(';')[0]!.split('=').slice(1).join('=');
}

async function listEvents(): Promise<{ event_type: string; client_id: string }[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    'SELECT event_type, client_id FROM homectl_auth.activity_events ORDER BY id',
  );
  return rows as { event_type: string; client_id: string }[];
}

async function insertEventAt(userId: string, ageDays: number): Promise<void> {
  await getPool().query(
    `INSERT INTO homectl_auth.activity_events (user_id, client_id, event_type, occurred_at)
     VALUES ($1, $2, 'login', NOW() - make_interval(days => $3))`,
    [userId, TEST_APP_ID, ageDays],
  );
}

async function adminToken(): Promise<string> {
  const user = await createTestUser({ isAdmin: true, email: 'admin@example.com', username: 'admin' });
  return signAccessToken({
    sub: user.id,
    email: user.email,
    isAdmin: true,
    apps: [],
    clientId: TEST_APP_ID,
  });
}

// ── Recording ──────────────────────────────────────────────────────────────

describe('activity recording', () => {
  it('POST /login stamps last_login_at and records a login event', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    expect(user.lastLoginAt).toBeNull();

    await login(user.username, user.plainPassword);

    const { rows } = await getPool().query<Record<string, unknown>>(
      'SELECT last_login_at FROM homectl_auth.users WHERE id = $1',
      [user.id],
    );
    expect(rows[0]!['last_login_at']).not.toBeNull();

    expect(await listEvents()).toEqual([{ event_type: 'login', client_id: TEST_APP_ID }]);
  });

  it('SSO short-circuit on GET /authorize records an sso_login event', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const cookies = await login(user.username, user.plainPassword);
    const sso = extractCookie(cookies, 'homectl_sso');
    expect(sso).toBeTruthy();

    const res = await request(app)
      .get('/authorize')
      .query({ response_type: 'code', client_id: TEST_APP_ID, redirect_uri: REDIRECT_URI })
      .set('Cookie', `homectl_sso=${sso}`);
    expect(res.status).toBe(302);

    const events = await listEvents();
    expect(events.map((e) => e.event_type)).toEqual(['login', 'sso_login']);
  });

  it('POST /refresh records refresh activity coalesced per user+app+hour', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const cookies = await login(user.username, user.plainPassword);
    let refreshToken = extractCookie(cookies, `homectl_refresh_${TEST_APP_ID}`);

    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post('/refresh')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', `homectl_refresh_${TEST_APP_ID}=${refreshToken}`);
      expect(res.status).toBe(200);
      const raw = res.headers['set-cookie'];
      const newCookies = (Array.isArray(raw) ? raw : raw ? [raw] : []) as string[];
      refreshToken = extractCookie(newCookies, `homectl_refresh_${TEST_APP_ID}`);
    }

    // Two refreshes within the hour → one coalesced 'refresh' event
    const events = await listEvents();
    expect(events.map((e) => e.event_type)).toEqual(['login', 'refresh']);
  });

  it('a failed login records nothing and leaves last_login_at NULL', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');

    await request(app).post('/login').type('form').send({
      client_id: TEST_APP_ID,
      redirect_uri: REDIRECT_URI,
      state: '',
      username: user.username,
      password: 'wrong-password',
    });

    expect(await listEvents()).toEqual([]);
    const { rows } = await getPool().query<Record<string, unknown>>(
      'SELECT last_login_at FROM homectl_auth.users WHERE id = $1',
      [user.id],
    );
    expect(rows[0]!['last_login_at']).toBeNull();
  });
});

// ── Stats API ──────────────────────────────────────────────────────────────

describe('GET /admin/api/stats/*', () => {
  it('requires an admin token', async () => {
    const res = await request(app).get('/admin/api/stats/overview');
    expect(res.status).toBe(401);
  });

  it('overview returns headline counts and live sessions per app', async () => {
    const token = await adminToken();
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    await login(user.username, user.plainPassword);

    const res = await request(app)
      .get('/admin/api/stats/overview')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalUsers).toBe(2); // admin + user
    expect(res.body.neverLoggedIn).toBe(1); // the admin never logged in via /login
    expect(res.body.activeUsers).toEqual({ day: 1, week: 1, month: 1 });
    expect(res.body.totalActiveSessions).toBe(1);
    expect(res.body.activeSessions).toEqual([
      { clientId: TEST_APP_ID, name: TEST_APP.name, sessions: 1, users: 1 },
    ]);
  });

  it('activity returns a zero-filled daily series of the requested length', async () => {
    const token = await adminToken();
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    await login(user.username, user.plainPassword);

    const res = await request(app)
      .get('/admin/api/stats/activity?days=7')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.series).toHaveLength(7);
    const today = res.body.series[6];
    expect(today.logins).toBe(1);
    expect(today.activeUsers).toBe(1);
    expect(res.body.series[0]).toMatchObject({ logins: 0, activeUsers: 0 });
  });

  it('clamps an out-of-range days parameter', async () => {
    const token = await adminToken();
    const res = await request(app)
      .get('/admin/api/stats/activity?days=9999')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(365);
  });

  it('apps returns per-app usage including configured apps with no activity', async () => {
    const token = await adminToken();
    const u1 = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const u2 = await createTestUserWithAccess(TEST_APP_ID, 'viewer', {
      email: 'second@example.com',
      username: 'second',
    });
    await login(u1.username, u1.plainPassword);
    await login(u2.username, u2.plainPassword);

    const res = await request(app)
      .get('/admin/api/stats/apps?days=30')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const testApp = res.body.apps.find((a: { clientId: string }) => a.clientId === TEST_APP_ID);
    expect(testApp).toMatchObject({
      name: TEST_APP.name,
      configured: true,
      grantedUsers: 2,
      logins: 2,
      activeUsers: 2,
    });
    expect(testApp.lastUsedAt).toBeTruthy();
  });

  it('user activity endpoint returns per-app usage and recent events', async () => {
    const token = await adminToken();
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    await login(user.username, user.plainPassword);

    const res = await request(app)
      .get(`/admin/api/users/${user.id}/activity`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.apps).toHaveLength(1);
    expect(res.body.apps[0]).toMatchObject({
      clientId: TEST_APP_ID,
      name: TEST_APP.name,
      logins: 1,
      activeDays: 1,
    });
    expect(res.body.recent).toHaveLength(1);
    expect(res.body.recent[0].eventType).toBe('login');
  });

  it('user activity endpoint 404s for an unknown user', async () => {
    const token = await adminToken();
    const res = await request(app)
      .get('/admin/api/users/00000000-0000-0000-0000-000000000000/activity')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

// ── Retention ──────────────────────────────────────────────────────────────

describe('activity event retention', () => {
  it('cleanup prunes events older than the default 90 days', async () => {
    const user = await createTestUser();
    await insertEventAt(user.id, 91);
    await insertEventAt(user.id, 5);

    await runCleanup();

    const { rows } = await getPool().query('SELECT id FROM homectl_auth.activity_events');
    expect(rows).toHaveLength(1);
  });

  it('respects ACTIVITY_RETENTION_DAYS', async () => {
    process.env['ACTIVITY_RETENTION_DAYS'] = '30';
    const user = await createTestUser();
    await insertEventAt(user.id, 31);
    await insertEventAt(user.id, 5);

    await runCleanup();

    const { rows } = await getPool().query('SELECT id FROM homectl_auth.activity_events');
    expect(rows).toHaveLength(1);
  });
});
