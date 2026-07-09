/**
 * Integration tests for the sidecar app.
 *
 * Uses a real Express upstream that echoes the headers it receives (so we can
 * assert on header stripping/injection), a local JWKS key set for verification
 * (no network), and a mocked global fetch for the /token and /internal/refresh
 * server-to-server calls.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import request from 'supertest';
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
  type KeyLike,
  type JWTVerifyGetKey,
} from 'jose';
import { createHash } from 'crypto';
import { loadConfig, type ProxyConfig } from '../config';
import { createProxyApp } from '../app';
import { open, seal, type Session } from '../session';
import { signState } from '../state';

const PUBLIC_AUTH_URL = 'https://auth.homectl.no';
const INTERNAL_AUTH_URL = 'http://homectl-auth.homectl';
const CLIENT_ID = 'test-app';
const APP_BASE_URL = 'https://test-app.homectl.no';
const COOKIE_KEY_B64 = Buffer.alloc(32, 9).toString('base64');

let privateKey: KeyLike;
let kid: string;
let localJwks: JWTVerifyGetKey;
let jwksKeys: unknown[];
let upstreamServer: Server;
let config: ProxyConfig;

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const jsonRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

async function makeToken(
  overrides: { sub?: string; email?: string; role?: string; expiresInSec?: number } = {},
): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (overrides.expiresInSec ?? 900);
  const token = await new SignJWT({
    email: overrides.email ?? 'user@example.com',
    isAdmin: false,
    apps: [{ appId: CLIENT_ID, role: overrides.role ?? 'editor' }],
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(PUBLIC_AUTH_URL)
    .setAudience(CLIENT_ID)
    .setSubject(overrides.sub ?? 'user-1')
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);
  return { token, exp };
}

function sealedCookie(session: Session): string {
  return `${config.sessionCookieName}=${seal(session, config.cookieKey)}`;
}

function getSetCookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  if (!found) return undefined;
  return decodeURIComponent(found.split(';')[0]!.slice(name.length + 1));
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { modulusLength: 2048 });
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  kid = createHash('sha256').update(JSON.stringify(jwk)).digest('hex').slice(0, 16);
  jwksKeys = [{ ...jwk, use: 'sig', alg: 'RS256', kid }];
  localJwks = createLocalJWKSet({ keys: jwksKeys as never });

  // Upstream echo server on an ephemeral port.
  const upstream = express();
  upstream.all(/.*/, (req, res) => {
    res.json({ path: req.path, method: req.method, headers: req.headers });
  });
  upstreamServer = await new Promise<Server>((resolve) => {
    const s = upstream.listen(0, () => resolve(s));
  });
  const addr = upstreamServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  config = loadConfig({
    PUBLIC_AUTH_URL,
    INTERNAL_AUTH_URL,
    AUTH_CLIENT_ID: CLIENT_ID,
    AUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL,
    UPSTREAM: `http://127.0.0.1:${port}`,
    COOKIE_KEY: COOKIE_KEY_B64,
    NODE_ENV: 'test',
  } as NodeJS.ProcessEnv);

  mockFetch.mockImplementation(async () => jsonRes(404, {}));
});

afterAll(() => {
  vi.unstubAllGlobals();
  upstreamServer?.close();
});

function buildApp() {
  return createProxyApp({ config, jwksProvider: localJwks });
}

// ── Health ────────────────────────────────────────────────────────────────

describe('health endpoints', () => {
  it('GET /healthz → 200', async () => {
    const res = await request(buildApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /readyz → 200 when JWKS is reachable', async () => {
    mockFetch.mockImplementationOnce(async () => jsonRes(200, { keys: jwksKeys }));
    const res = await request(buildApp()).get('/readyz');
    expect(res.status).toBe(200);
  });

  it('GET /readyz → 503 when JWKS is unreachable', async () => {
    mockFetch.mockImplementationOnce(async () => jsonRes(500, {}));
    const res = await request(buildApp()).get('/readyz');
    expect(res.status).toBe(503);
  });
});

// ── Unauthenticated ─────────────────────────────────────────────────────────

describe('unauthenticated requests', () => {
  it('redirects an HTML navigation to /authorize with a state cookie', async () => {
    const res = await request(buildApp())
      .get('/dashboard')
      .set('Accept', 'text/html,application/xhtml+xml');

    expect(res.status).toBe(302);
    const loc = res.headers['location'];
    expect(loc).toContain(`${PUBLIC_AUTH_URL}/authorize`);
    expect(loc).toContain(`client_id=${CLIENT_ID}`);
    expect(loc).toContain(`redirect_uri=${encodeURIComponent(config.redirectUri)}`);
    expect(loc).toContain('response_type=code');
    expect(getSetCookie(res, 'hs_state')).toBeTruthy();
  });

  it('answers an XHR/API request with 401 (never redirects)', async () => {
    const res = await request(buildApp()).get('/api/data').set('Accept', 'application/json');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.headers['location']).toBeUndefined();
  });
});

// ── Callback ────────────────────────────────────────────────────────────────

describe('OAuth callback', () => {
  it('rejects a callback with no state cookie', async () => {
    const res = await request(buildApp())
      .get('/auth/callback')
      .query({ code: 'c', state: 'nonce' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_state');
  });

  it('rejects a callback with a mismatched state', async () => {
    const stateCookie = signState({ nonce: 'real-nonce', returnTo: '/' }, config.cookieKey);
    const res = await request(buildApp())
      .get('/auth/callback')
      .set('Cookie', `hs_state=${stateCookie}`)
      .query({ code: 'c', state: 'wrong-nonce' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('state_mismatch');
  });

  it('exchanges the code, captures the refresh cookie, and establishes a session', async () => {
    const { token, exp } = await makeToken({ sub: 'user-42', role: 'admin' });
    mockFetch.mockImplementationOnce(async (url: string) => {
      expect(String(url)).toBe(`${INTERNAL_AUTH_URL}/token`);
      return jsonRes(200, { access_token: token, token_type: 'Bearer', expires_in: 900 });
    });

    const stateCookie = signState({ nonce: 'nonce-ok', returnTo: '/dashboard' }, config.cookieKey);
    const res = await request(buildApp())
      .get('/auth/callback')
      .set('Cookie', [`hs_state=${stateCookie}`, `homectl_refresh_${CLIENT_ID}=initial-refresh`])
      .query({ code: 'valid-code', state: 'nonce-ok' });

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/dashboard');

    const sealed = getSetCookie(res, config.sessionCookieName);
    expect(sealed).toBeTruthy();
    const session = open(sealed, config.cookieKey);
    expect(session).toMatchObject({
      refreshToken: 'initial-refresh',
      accessToken: token,
      accessExp: exp,
      sub: 'user-42',
      role: 'admin',
    });
  });

  it('sanitizes an off-site return_to to /', async () => {
    const { token } = await makeToken();
    mockFetch.mockImplementationOnce(async () =>
      jsonRes(200, { access_token: token, expires_in: 900 }),
    );
    const stateCookie = signState(
      { nonce: 'n2', returnTo: 'https://evil.com' },
      config.cookieKey,
    );
    const res = await request(buildApp())
      .get('/auth/callback')
      .set('Cookie', [`hs_state=${stateCookie}`, `homectl_refresh_${CLIENT_ID}=r`])
      .query({ code: 'c', state: 'n2' });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/');
  });

  it('returns 502 when the code exchange fails', async () => {
    mockFetch.mockImplementationOnce(async () => jsonRes(400, { error: 'invalid_grant' }));
    const stateCookie = signState({ nonce: 'n3', returnTo: '/' }, config.cookieKey);
    const res = await request(buildApp())
      .get('/auth/callback')
      .set('Cookie', `hs_state=${stateCookie}`)
      .query({ code: 'bad', state: 'n3' });
    expect(res.status).toBe(502);
  });
});

// ── Authenticated proxying ──────────────────────────────────────────────────

describe('authenticated proxying', () => {
  it('proxies to upstream with injected identity headers', async () => {
    const { token, exp } = await makeToken({ sub: 'user-1', email: 'a@b.no', role: 'editor' });
    const session: Session = {
      refreshToken: 'r',
      accessToken: token,
      accessExp: exp,
      sub: 'user-1',
      email: 'a@b.no',
      role: 'editor',
    };

    const res = await request(buildApp()).get('/api/thing').set('Cookie', sealedCookie(session));

    expect(res.status).toBe(200);
    expect(res.body.headers.authorization).toBe(`Bearer ${token}`);
    expect(res.body.headers['x-homectl-user']).toBe('user-1');
    expect(res.body.headers['x-homectl-email']).toBe('a@b.no');
    expect(res.body.headers['x-homectl-role']).toBe('editor');
  });

  it('strips forged inbound identity headers before proxying (security regression)', async () => {
    const { token, exp } = await makeToken({ sub: 'real-user' });
    const session: Session = {
      refreshToken: 'r',
      accessToken: token,
      accessExp: exp,
      sub: 'real-user',
      email: 'real@b.no',
      role: 'editor',
    };

    const res = await request(buildApp())
      .get('/api/thing')
      .set('Cookie', sealedCookie(session))
      .set('Authorization', 'Bearer forged-token')
      .set('X-Homectl-User', 'attacker')
      .set('X-Homectl-Email', 'attacker@evil.com')
      .set('X-Homectl-Role', 'admin');

    expect(res.status).toBe(200);
    expect(res.body.headers.authorization).toBe(`Bearer ${token}`);
    expect(res.body.headers.authorization).not.toContain('forged-token');
    expect(res.body.headers['x-homectl-user']).toBe('real-user');
    expect(res.body.headers['x-homectl-email']).toBe('real@b.no');
    expect(res.body.headers['x-homectl-role']).toBe('editor');
  });

  it('refreshes a near-expiry access token and rotates the refresh token', async () => {
    const stale = await makeToken({ sub: 'user-1', expiresInSec: 10 }); // within 60s skew
    const fresh = await makeToken({ sub: 'user-1', role: 'editor' });

    mockFetch.mockImplementationOnce(async (url: string) => {
      expect(String(url)).toBe(`${INTERNAL_AUTH_URL}/internal/refresh`);
      return jsonRes(200, { access_token: fresh.token, refresh_token: 'rotated-refresh' });
    });

    const session: Session = {
      refreshToken: 'old-refresh',
      accessToken: stale.token,
      accessExp: stale.exp,
      sub: 'user-1',
      email: 'user@example.com',
      role: 'editor',
    };

    const res = await request(buildApp()).get('/api/thing').set('Cookie', sealedCookie(session));

    expect(res.status).toBe(200);
    expect(res.body.headers.authorization).toBe(`Bearer ${fresh.token}`);

    // Session cookie rewritten with the rotated refresh token.
    const rewritten = open(getSetCookie(res, config.sessionCookieName), config.cookieKey);
    expect(rewritten?.refreshToken).toBe('rotated-refresh');
    expect(rewritten?.accessToken).toBe(fresh.token);
  });

  it('forces re-login (302) for an HTML request when refresh fails', async () => {
    mockFetch.mockImplementationOnce(async () => jsonRes(401, { error: 'invalid_refresh_token' }));
    const stale = await makeToken({ expiresInSec: 5 });
    const session: Session = {
      refreshToken: 'dead',
      accessToken: stale.token,
      accessExp: stale.exp,
      sub: 'user-1',
      email: 'user@example.com',
      role: 'editor',
    };

    const res = await request(buildApp())
      .get('/dashboard')
      .set('Accept', 'text/html')
      .set('Cookie', sealedCookie(session));

    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain(`${PUBLIC_AUTH_URL}/authorize`);
    // Session cookie cleared.
    const cleared = res.headers['set-cookie'] as unknown as string[];
    expect(cleared.some((c) => c.startsWith(`${config.sessionCookieName}=`))).toBe(true);
  });

  it('answers 401 for an XHR when refresh fails', async () => {
    mockFetch.mockImplementationOnce(async () => jsonRes(401, {}));
    const stale = await makeToken({ expiresInSec: 5 });
    const session: Session = {
      refreshToken: 'dead',
      accessToken: stale.token,
      accessExp: stale.exp,
      sub: 'user-1',
      email: 'user@example.com',
      role: 'editor',
    };

    const res = await request(buildApp())
      .get('/api/data')
      .set('Accept', 'application/json')
      .set('Cookie', sealedCookie(session));

    expect(res.status).toBe(401);
  });
});

// ── Logout ──────────────────────────────────────────────────────────────────

describe('logout', () => {
  it('clears the session cookie and redirects', async () => {
    const res = await request(buildApp()).post('/auth/logout');
    expect(res.status).toBe(302);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const cleared = cookies.find((c) => c.startsWith(`${config.sessionCookieName}=`));
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });
});

// ── Dev bypass ────────────────────────────────────────────────────────────────

describe('dev fake-identity bypass', () => {
  it('injects the fake identity and proxies without any auth flow', async () => {
    const devConfig = loadConfig({
      PUBLIC_AUTH_URL,
      INTERNAL_AUTH_URL,
      AUTH_CLIENT_ID: CLIENT_ID,
      AUTH_CLIENT_SECRET: 'client-secret',
      APP_BASE_URL,
      UPSTREAM: config.upstream,
      COOKIE_KEY: COOKIE_KEY_B64,
      NODE_ENV: 'development',
      DEV_FAKE_IDENTITY: JSON.stringify({ sub: 'dev-user', email: 'dev@x.no', role: 'admin' }),
    } as NodeJS.ProcessEnv);

    const devApp = createProxyApp({ config: devConfig, jwksProvider: localJwks });
    const res = await request(devApp)
      .get('/anything')
      .set('X-Homectl-User', 'attacker');

    expect(res.status).toBe(200);
    expect(res.body.headers['x-homectl-user']).toBe('dev-user');
    expect(res.body.headers['x-homectl-email']).toBe('dev@x.no');
    expect(res.body.headers['x-homectl-role']).toBe('admin');
    expect(res.body.headers.authorization).toBeUndefined();
  });
});
