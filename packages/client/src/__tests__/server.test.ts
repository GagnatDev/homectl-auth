/**
 * Unit tests for @gagnatdev/homectl-auth-client/server
 *
 * Uses vi.stubGlobal to mock fetch (so both jose's JWKS fetch and the token
 * exchange call are intercepted) plus a local key pair for signing test tokens.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type KeyLike } from 'jose';
import { createHash, createHmac } from 'crypto';
import cookieParser from 'cookie-parser';
import { createAuthClient } from '../server';

const AUTH_SERVICE_URL = 'https://auth.test.example.com';
const CLIENT_ID = 'test-app';
const CLIENT_SECRET = 'test-client-secret';
const APP_BASE_URL = 'https://app.test.example.com';
const CALLBACK_PATH = '/auth/callback';

let privateKey: KeyLike;
let kid: string;
let app: ReturnType<typeof express>;

// ── Setup ──────────────────────────────────────────────────────────────────

// A stable mock fetch that routes by URL
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { modulusLength: 2048 });
  privateKey = kp.privateKey;

  const jwk = await exportJWK(kp.publicKey);
  kid = createHash('sha256').update(JSON.stringify(jwk)).digest('hex').slice(0, 16);
  const jwksPayload = { keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid }] };

  // Default: JWKS fetch mock (not needed for JWT verify but may be called elsewhere)
  mockFetch.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'ignored', token_type: 'Bearer', expires_in: 900 }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  // Build app with local JWKS provider (avoids network calls during JWT verify)
  const localJwks = createLocalJWKSet(jwksPayload);

  app = express();
  app.use(cookieParser());
  app.use(express.json());

  const { authMiddleware, callbackHandler, logoutHandler } = createAuthClient({
    authServiceUrl: AUTH_SERVICE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    appBaseUrl: APP_BASE_URL,
    callbackPath: CALLBACK_PATH,
    _jwksProvider: localJwks,
  });

  app.get('/api/data', authMiddleware, (req, res) => {
    res.json({ user: req.user });
  });

  app.get('/protected', authMiddleware, (req, res) => {
    res.send(`<html><body>Hello ${req.user?.email}</body></html>`);
  });

  app.get(CALLBACK_PATH, callbackHandler);
  app.post('/auth/logout', logoutHandler);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function makeToken(overrides: {
  sub?: string;
  email?: string;
  isAdmin?: boolean;
  apps?: Array<{ appId: string; role: string }>;
  aud?: string;
  iss?: string;
  expired?: boolean;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const exp = overrides.expired ? now - 60 : now + 900;

  return new SignJWT({
    email: overrides.email ?? 'user@example.com',
    isAdmin: overrides.isAdmin ?? false,
    apps: overrides.apps ?? [{ appId: CLIENT_ID, role: 'editor' }],
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(overrides.iss ?? AUTH_SERVICE_URL)
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setSubject(overrides.sub ?? 'user-123')
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);
}

// ── authMiddleware ─────────────────────────────────────────────────────────

describe('authMiddleware', () => {
  it('populates req.user for a valid JWT on API request', async () => {
    const token = await makeToken();
    const res = await request(app)
      .get('/api/data')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('user-123');
    expect(res.body.user.email).toBe('user@example.com');
    expect(res.body.user.role).toBe('editor');
  });

  it('returns 401 for missing token on API request', async () => {
    const res = await request(app).get('/api/data');
    expect(res.status).toBe(401);
  });

  it('returns 401 for expired JWT on API request', async () => {
    const token = await makeToken({ expired: true });
    const res = await request(app)
      .get('/api/data')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 for JWT with wrong aud', async () => {
    const token = await makeToken({ aud: 'other-app' });
    const res = await request(app)
      .get('/api/data')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 for JWT with wrong iss', async () => {
    const token = await makeToken({ iss: 'https://evil.example.com' });
    const res = await request(app)
      .get('/api/data')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('redirects to /authorize for unauthenticated browser (HTML) requests', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Accept', 'text/html,application/xhtml+xml');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain(`${AUTH_SERVICE_URL}/authorize`);
    expect(res.headers['location']).toContain(`client_id=${CLIENT_ID}`);
  });

  it('sets a state cookie on browser redirect', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Accept', 'text/html');

    expect(res.status).toBe(302);
    const cookies = res.headers['set-cookie'];
    const cookieList: string[] = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
    expect(cookieList.some((c) => c.startsWith('homectl_auth_state='))).toBe(true);
  });

  it('sets req.user.role for the configured clientId', async () => {
    const token = await makeToken({
      apps: [
        { appId: CLIENT_ID, role: 'admin' },
        { appId: 'other-app', role: 'viewer' },
      ],
    });

    const res = await request(app)
      .get('/api/data')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
  });
});

// ── callbackHandler ────────────────────────────────────────────────────────

describe('callbackHandler', () => {
  function makeStateCookie(nonce: string, originalUrl = '/dashboard') {
    const payload = JSON.stringify({ nonce, originalUrl });
    const b64 = Buffer.from(payload).toString('base64');
    const sig = createHmac('sha256', CLIENT_SECRET).update(b64).digest('hex');
    return `${b64}.${sig}`;
  }

  it('rejects callback with no state cookie', async () => {
    const res = await request(app)
      .get(CALLBACK_PATH)
      .query({ code: 'somecode', state: 'nonce123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_state_cookie');
  });

  it('rejects callback with mismatched state', async () => {
    const cookie = makeStateCookie('nonce-abc');
    const res = await request(app)
      .get(CALLBACK_PATH)
      .set('Cookie', `homectl_auth_state=${cookie}`)
      .query({ code: 'somecode', state: 'wrong-nonce' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('state_mismatch');
  });

  it('redirects to original URL after successful code exchange', async () => {
    const nonce = 'test-nonce-ok';
    const cookie = makeStateCookie(nonce, '/dashboard');

    const res = await request(app)
      .get(CALLBACK_PATH)
      .set('Cookie', `homectl_auth_state=${cookie}`)
      .query({ code: 'validcode', state: nonce });

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/dashboard');
  });

  it('clears the state cookie after successful exchange (single-use)', async () => {
    const nonce = 'nonce-clear';
    const cookie = makeStateCookie(nonce, '/');

    const res = await request(app)
      .get(CALLBACK_PATH)
      .set('Cookie', `homectl_auth_state=${cookie}`)
      .query({ code: 'code-clear', state: nonce });

    expect(res.status).toBe(302);
    const responseCookies = res.headers['set-cookie'];
    const cookieList: string[] = Array.isArray(responseCookies)
      ? responseCookies
      : responseCookies
        ? [responseCookies]
        : [];

    // Cleared cookie has Expires in the past or Max-Age=0
    const cleared = cookieList.find((c) => c.startsWith('homectl_auth_state='));
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0|expires=Thu, 01 Jan 1970/i);
  });
});

// ── logoutHandler ──────────────────────────────────────────────────────────

describe('logoutHandler', () => {
  it('returns HTML page that calls logout and redirects', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(200);
    expect(res.type).toContain('html');
    expect(res.text).toContain(AUTH_SERVICE_URL);
    expect(res.text).toContain('/logout');
  });
});
