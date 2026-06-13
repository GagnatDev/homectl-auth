import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../app';
import { generateTestKeys, resetKeys, verifyAccessToken } from '../modules/token/token.service';
import {
  setupTestAppConfig,
  TEST_APP_ID,
  TEST_APP,
  createTestUserWithAccess,
  truncateTables,
} from './helpers/test-app-config';

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

afterAll(() => {
  resetKeys();
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Perform the full login flow and return the cookies set on the response.
 */
async function loginAndGetCookies(username: string, password: string) {
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
  return cookieHeader;
}

function extractCookie(cookies: string | string[], name: string): string | undefined {
  const list = Array.isArray(cookies) ? cookies : [cookies];
  const found = list.find((c) => c.startsWith(`${name}=`));
  if (!found) return undefined;
  return found.split(';')[0]!.split('=').slice(1).join('=');
}

// ── Refresh token rotation ─────────────────────────────────────────────────

describe('POST /refresh', () => {
  it('returns a new access_token and rotates the refresh cookie', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const setCookies = await loginAndGetCookies(user.username, user.plainPassword);
    const refreshToken = extractCookie(setCookies, `homectl_refresh_${TEST_APP_ID}`);
    expect(refreshToken).toBeTruthy();

    const res = await request(app)
      .post('/refresh')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', `homectl_refresh_${TEST_APP_ID}=${refreshToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('access_token');
    expect(res.body.token_type).toBe('Bearer');

    // New refresh cookie should be different
    const rawNew = res.headers['set-cookie'];
    const newCookies: string[] = Array.isArray(rawNew) ? rawNew : rawNew ? [rawNew] : [];
    const newRefreshToken = extractCookie(newCookies, `homectl_refresh_${TEST_APP_ID}`);
    expect(newRefreshToken).toBeTruthy();
    expect(newRefreshToken).not.toBe(refreshToken);
  });

  it('rejects a stale refresh token (already rotated)', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const setCookies = await loginAndGetCookies(user.username, user.plainPassword);
    const oldRefreshToken = extractCookie(setCookies, `homectl_refresh_${TEST_APP_ID}`);

    // First refresh — consumes the old token
    await request(app)
      .post('/refresh')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', `homectl_refresh_${TEST_APP_ID}=${oldRefreshToken}`);

    // Second refresh with the same old token — should fail
    const res2 = await request(app)
      .post('/refresh')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', `homectl_refresh_${TEST_APP_ID}=${oldRefreshToken}`);

    expect(res2.status).toBe(401);
  });

  it('returns 401 when no refresh cookie is present', async () => {
    const res = await request(app)
      .post('/refresh')
      .set('Origin', APP_ORIGIN);
    expect(res.status).toBe(401);
  });

  it('returns 403 for unknown origin (CORS rejected)', async () => {
    const res = await request(app)
      .post('/refresh')
      .set('Origin', 'https://unknown.example.com');
    expect(res.status).toBe(403);
  });

  it('access token aud matches the client_id', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'viewer');
    const setCookies = await loginAndGetCookies(user.username, user.plainPassword);
    const refreshToken = extractCookie(setCookies, `homectl_refresh_${TEST_APP_ID}`);

    const res = await request(app)
      .post('/refresh')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', `homectl_refresh_${TEST_APP_ID}=${refreshToken}`);

    expect(res.status).toBe(200);
    const payload = await verifyAccessToken(res.body.access_token, TEST_APP_ID);
    expect(payload.aud).toBe(TEST_APP_ID);
    expect(payload.sub).toBe(user.id);
  });
});

// ── Logout ─────────────────────────────────────────────────────────────────

describe('POST /logout', () => {
  it('returns 204 and clears the per-app refresh cookie', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const setCookies = await loginAndGetCookies(user.username, user.plainPassword);
    const refreshToken = extractCookie(setCookies, `homectl_refresh_${TEST_APP_ID}`);

    const logoutRes = await request(app)
      .post('/logout')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', `homectl_refresh_${TEST_APP_ID}=${refreshToken}`);

    expect(logoutRes.status).toBe(204);

    // Subsequent refresh should fail
    const refreshRes = await request(app)
      .post('/refresh')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', `homectl_refresh_${TEST_APP_ID}=${refreshToken}`);

    expect(refreshRes.status).toBe(401);
  });

  it('preserves the homectl_sso cookie on logout', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const setCookies = await loginAndGetCookies(user.username, user.plainPassword);
    const refreshToken = extractCookie(setCookies, `homectl_refresh_${TEST_APP_ID}`);
    const ssoToken = extractCookie(setCookies, 'homectl_sso');
    expect(ssoToken).toBeTruthy();

    const logoutRes = await request(app)
      .post('/logout')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', [
        `homectl_refresh_${TEST_APP_ID}=${refreshToken}`,
        `homectl_sso=${ssoToken}`,
      ].join('; '));

    // SSO cookie should NOT be cleared in the response
    const rawLogout = logoutRes.headers['set-cookie'];
    const responseCookies: string[] = Array.isArray(rawLogout) ? rawLogout : rawLogout ? [rawLogout] : [];
    const ssoClearCookie = responseCookies.find((c) => c.startsWith('homectl_sso='));
    // If a Set-Cookie for sso exists, it should not be an expiry/clear directive
    if (ssoClearCookie) {
      expect(ssoClearCookie).not.toContain('Expires=Thu, 01 Jan 1970');
    }
  });

  it('is idempotent — succeeds when called without cookies', async () => {
    const res = await request(app)
      .post('/logout')
      .set('Origin', APP_ORIGIN);
    expect(res.status).toBe(204);
  });
});

// ── CORS ───────────────────────────────────────────────────────────────────

describe('CORS on /refresh and /logout', () => {
  it('/refresh responds with ACAO header for registered origin', async () => {
    const res = await request(app)
      .post('/refresh')
      .set('Origin', APP_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('/logout responds with ACAO header for registered origin', async () => {
    const res = await request(app)
      .post('/logout')
      .set('Origin', APP_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
  });

  it('/refresh blocks unregistered origin with 403', async () => {
    const res = await request(app)
      .post('/refresh')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
  });

  it('responds to OPTIONS preflight with 204', async () => {
    const res = await request(app)
      .options('/refresh')
      .set('Origin', APP_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
  });
});

// ── SSO cookie short-circuit ───────────────────────────────────────────────

describe('SSO short-circuit on GET /authorize', () => {
  it('skips login form and redirects with code when sso cookie is valid', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');

    // First login — establishes sso cookie
    const firstLogin = await loginAndGetCookies(user.username, user.plainPassword);
    const ssoCookie = extractCookie(firstLogin, 'homectl_sso');
    expect(ssoCookie).toBeTruthy();

    // Second app authorization with only the sso cookie (no login form interaction)
    const res = await request(app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: TEST_APP_ID,
        redirect_uri: REDIRECT_URI,
        state: 'ssostate',
      })
      .set('Cookie', `homectl_sso=${ssoCookie}`);

    expect(res.status).toBe(302);
    const url = new URL(res.headers['location'] as string);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('ssostate');
  });

  it('serves the login SPA shell (no redirect) when sso cookie is absent', async () => {
    const res = await request(app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: TEST_APP_ID,
        redirect_uri: REDIRECT_URI,
        state: '',
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });
});
