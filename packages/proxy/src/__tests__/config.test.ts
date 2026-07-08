import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config';

const VALID = {
  PUBLIC_AUTH_URL: 'https://auth.homectl.no',
  INTERNAL_AUTH_URL: 'http://homectl-auth.homectl',
  AUTH_CLIENT_ID: 'workbench',
  AUTH_CLIENT_SECRET: 'plaintext-secret',
  APP_BASE_URL: 'https://workbench.homectl.no',
  UPSTREAM: 'http://127.0.0.1:3000',
  COOKIE_KEY: Buffer.alloc(32, 1).toString('base64'),
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a valid config and applies defaults', () => {
    const c = loadConfig(VALID);
    expect(c.clientId).toBe('workbench');
    expect(c.callbackPath).toBe('/auth/callback');
    expect(c.logoutPath).toBe('/auth/logout');
    expect(c.listenPort).toBe(4180);
    expect(c.refreshSkewSeconds).toBe(60);
    expect(c.sessionCookieName).toBe('hs_session');
    expect(c.redirectUri).toBe('https://workbench.homectl.no/auth/callback');
    expect(c.jwksUrl).toBe('http://homectl-auth.homectl/.well-known/jwks.json');
    expect(c.cookieKey).toHaveLength(32);
    expect(c.devIdentity).toBeNull();
  });

  it('strips trailing slashes from URLs', () => {
    const c = loadConfig({ ...VALID, INTERNAL_AUTH_URL: 'http://homectl-auth.homectl/' });
    expect(c.jwksUrl).toBe('http://homectl-auth.homectl/.well-known/jwks.json');
  });

  it('normalizes paths to start with a slash', () => {
    const c = loadConfig({ ...VALID, CALLBACK_PATH: 'cb', LOGOUT_PATH: 'out' });
    expect(c.callbackPath).toBe('/cb');
    expect(c.logoutPath).toBe('/out');
  });

  it('lists every missing required var', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/PUBLIC_AUTH_URL/);
    try {
      loadConfig({} as NodeJS.ProcessEnv);
    } catch (e) {
      const msg = (e as Error).message;
      for (const key of [
        'PUBLIC_AUTH_URL',
        'INTERNAL_AUTH_URL',
        'AUTH_CLIENT_ID',
        'AUTH_CLIENT_SECRET',
        'APP_BASE_URL',
        'UPSTREAM',
        'COOKIE_KEY',
      ]) {
        expect(msg).toContain(key);
      }
    }
  });

  it('rejects a cookie key that is not 32 bytes', () => {
    expect(() => loadConfig({ ...VALID, COOKIE_KEY: Buffer.alloc(16).toString('base64') })).toThrow(
      /COOKIE_KEY/,
    );
  });

  it('rejects a non-URL PUBLIC_AUTH_URL', () => {
    expect(() => loadConfig({ ...VALID, PUBLIC_AUTH_URL: 'not-a-url' })).toThrow(/PUBLIC_AUTH_URL/);
  });

  it('parses a dev fake identity', () => {
    const c = loadConfig({
      ...VALID,
      NODE_ENV: 'development',
      DEV_FAKE_IDENTITY: JSON.stringify({ sub: 'dev', email: 'dev@x.no', role: 'admin' }),
    });
    expect(c.devIdentity).toEqual({ sub: 'dev', email: 'dev@x.no', role: 'admin' });
  });

  it('refuses a dev fake identity in production', () => {
    expect(() =>
      loadConfig({
        ...VALID,
        NODE_ENV: 'production',
        DEV_FAKE_IDENTITY: JSON.stringify({ sub: 'dev', email: 'dev@x.no' }),
      }),
    ).toThrow(/DEV_FAKE_IDENTITY/);
  });

  it('rejects malformed DEV_FAKE_IDENTITY json', () => {
    expect(() =>
      loadConfig({ ...VALID, NODE_ENV: 'development', DEV_FAKE_IDENTITY: '{not json' }),
    ).toThrow(/DEV_FAKE_IDENTITY/);
  });
});
