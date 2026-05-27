import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../app';
import { generateTestKeys, resetKeys } from '../modules/token/token.service';
import {
  setupTestAppConfig,
  TEST_APP_ID,
  TEST_CLIENT_SECRET,
  TEST_APP,
  createTestUser,
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

// ── GET /authorize ─────────────────────────────────────────────────────────

describe('GET /authorize', () => {
  it('returns 200 with login form for valid client_id + redirect_uri', async () => {
    const res = await request(app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: TEST_APP_ID,
        redirect_uri: REDIRECT_URI,
        state: 'abc123',
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Test App');
    expect(res.text).toContain('Log in');
  });

  it('returns 400 for unknown client_id', async () => {
    const res = await request(app)
      .get('/authorize')
      .query({ response_type: 'code', client_id: 'nonexistent', redirect_uri: REDIRECT_URI });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_client');
  });

  it('returns 400 for invalid redirect_uri', async () => {
    const res = await request(app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: TEST_APP_ID,
        redirect_uri: 'https://evil.example.com/callback',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('returns 400 for unsupported response_type', async () => {
    const res = await request(app)
      .get('/authorize')
      .query({ response_type: 'token', client_id: TEST_APP_ID, redirect_uri: REDIRECT_URI });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_response_type');
  });
});

// ── POST /login ────────────────────────────────────────────────────────────

describe('POST /login', () => {
  it('redirects to redirect_uri with code + state when credentials are valid', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({
        client_id: TEST_APP_ID,
        redirect_uri: REDIRECT_URI,
        state: 'mystate',
        username: user.username,
        password: user.plainPassword,
      });

    expect(res.status).toBe(302);
    const location = res.headers['location'] as string;
    expect(location).toContain(REDIRECT_URI);
    const url = new URL(location);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('mystate');
  });

  it('returns 401 for wrong password', async () => {
    const user = await createTestUser();

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({
        client_id: TEST_APP_ID,
        redirect_uri: REDIRECT_URI,
        state: '',
        username: user.username,
        password: 'wrong-password',
      });

    expect(res.status).toBe(401);
  });

  it('returns 401 for unknown username', async () => {
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({
        client_id: TEST_APP_ID,
        redirect_uri: REDIRECT_URI,
        state: '',
        username: 'nobody',
        password: 'anything',
      });

    expect(res.status).toBe(401);
  });

  it('returns 403 when user lacks app access', async () => {
    const user = await createTestUser(); // no app access granted

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({
        client_id: TEST_APP_ID,
        redirect_uri: REDIRECT_URI,
        state: '',
        username: user.username,
        password: user.plainPassword,
      });

    expect(res.status).toBe(403);
  });

  it('allows login using email as the username field', async () => {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'viewer');

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({
        client_id: TEST_APP_ID,
        redirect_uri: REDIRECT_URI,
        state: '',
        username: user.email,
        password: user.plainPassword,
      });

    expect(res.status).toBe(302);
    const url = new URL(res.headers['location'] as string);
    expect(url.searchParams.get('code')).toBeTruthy();
  });
});

// ── POST /token ────────────────────────────────────────────────────────────

describe('POST /token — authorization code exchange', () => {
  async function getCode(): Promise<string> {
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({
        client_id: TEST_APP_ID,
        redirect_uri: REDIRECT_URI,
        state: '',
        username: user.username,
        password: user.plainPassword,
      });
    const url = new URL(res.headers['location'] as string);
    return url.searchParams.get('code')!;
  }

  it('returns access_token on valid exchange', async () => {
    const code = await getCode();

    const res = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code,
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('access_token');
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(900);
  });

  it('rejects a second exchange of the same code', async () => {
    const code = await getCode();

    await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code,
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    });

    const res2 = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code,
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    });

    expect(res2.status).toBe(400);
    expect(res2.body.error).toBe('invalid_grant');
  });

  it('rejects wrong client_secret with 401', async () => {
    const code = await getCode();

    const res = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code,
      client_id: TEST_APP_ID,
      client_secret: 'wrong-secret',
      redirect_uri: REDIRECT_URI,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects mismatched redirect_uri', async () => {
    const code = await getCode();

    const res = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code,
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      redirect_uri: 'https://other.example.com/callback',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects mismatched client_id', async () => {
    const code = await getCode();

    const res = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code,
      client_id: 'other-app',
      client_secret: TEST_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    });

    // other-app doesn't exist → invalid_client
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects invalid (nonexistent) code', async () => {
    const res = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code: 'deadbeef'.repeat(8),
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('returns 400 for unsupported grant_type', async () => {
    const res = await request(app).post('/token').send({
      grant_type: 'client_credentials',
      client_id: TEST_APP_ID,
      client_secret: TEST_CLIENT_SECRET,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });
});
