import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../app';
import { generateTestKeys, resetKeys, verifyAccessToken } from '../modules/token/token.service';
import { getPool } from '../db';
import {
  setupTestAppConfig,
  TEST_APP_ID,
  TEST_APP,
  TEST_CLIENT_SECRET,
  createTestUserWithAccess,
  truncateTables,
} from './helpers/test-app-config';

const REDIRECT_URI = TEST_APP.allowedRedirectUris[0]!;

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

// ── Helpers ────────────────────────────────────────────────────────────────

/** Log in and return the raw per-app refresh token (the value a sidecar holds). */
async function loginAndGetRefreshToken(username: string, password: string): Promise<string> {
  const res = await request(app).post('/login').type('form').send({
    client_id: TEST_APP_ID,
    redirect_uri: REDIRECT_URI,
    state: '',
    username,
    password,
  });
  expect(res.status).toBe(302);
  const raw = res.headers['set-cookie'];
  const cookieHeader: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookieHeader.find((c) => c.startsWith(`homectl_refresh_${TEST_APP_ID}=`));
  const token = cookie?.split(';')[0]!.split('=').slice(1).join('=');
  expect(token).toBeTruthy();
  return token!;
}

// ── POST /internal/refresh ───────────────────────────────────────────────────

describe('POST /internal/refresh', () => {
  it('returns an access token and the rotated refresh token in the body', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const refreshToken = await loginAndGetRefreshToken(user.username, user.plainPassword);

    const res = await request(app).post('/internal/refresh').send({
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      refresh_token: refreshToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(900);
    expect(res.body).toHaveProperty('access_token');
    // Rotated refresh token comes back in the JSON body, never as a cookie.
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.refresh_token).not.toBe(refreshToken);
    expect(res.headers['set-cookie']).toBeUndefined();

    const payload = await verifyAccessToken(res.body.access_token, TEST_APP_ID);
    expect(payload.aud).toBe(TEST_APP_ID);
    expect(payload.sub).toBe(user.id);
  });

  it('invalidates the old refresh token after rotation', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const refreshToken = await loginAndGetRefreshToken(user.username, user.plainPassword);

    const first = await request(app).post('/internal/refresh').send({
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    expect(first.status).toBe(200);

    // Reusing the consumed token must fail.
    const replay = await request(app).post('/internal/refresh').send({
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('invalid_refresh_token');

    // The newly issued token works.
    const next = await request(app).post('/internal/refresh').send({
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      refresh_token: first.body.refresh_token,
    });
    expect(next.status).toBe(200);
  });

  it('rejects a bad client secret with 401 invalid_client', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const refreshToken = await loginAndGetRefreshToken(user.username, user.plainPassword);

    const res = await request(app).post('/internal/refresh').send({
      client_id: TEST_APP_ID,
      client_secret: 'wrong-secret',
      refresh_token: refreshToken,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects an unknown client with 401 invalid_client', async () => {
    const res = await request(app).post('/internal/refresh').send({
      client_id: 'no-such-app',
      client_secret: TEST_CLIENT_SECRET,
      refresh_token: 'whatever',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('returns 400 when fields are missing', async () => {
    const res = await request(app).post('/internal/refresh').send({
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('returns 401 for an unknown refresh token (valid client)', async () => {
    const res = await request(app).post('/internal/refresh').send({
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      refresh_token: 'deadbeef-not-a-real-token',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_refresh_token');
  });

  it('returns 403 access_revoked when the user lost access after the session was created', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const refreshToken = await loginAndGetRefreshToken(user.username, user.plainPassword);

    // Revoke access out from under the live session.
    await getPool().query(
      'DELETE FROM homectl_auth.app_access WHERE user_id = $1 AND app_id = $2',
      [user.id, TEST_APP_ID],
    );

    const res = await request(app).post('/internal/refresh').send({
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      refresh_token: refreshToken,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access_revoked');
  });
});
