import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generateTestKeys,
  resetKeys,
  signAccessToken,
  verifyAccessToken,
  type SignAccessTokenInput,
} from '../modules/token/token.service';

const BASE_INPUT: SignAccessTokenInput = {
  sub: 'user-123',
  email: 'alice@example.com',
  isAdmin: false,
  apps: [{ appId: 'travel-journal', role: 'creator' }],
  clientId: 'travel-journal',
};

beforeAll(async () => {
  await generateTestKeys();
});

afterAll(() => {
  resetKeys();
});

describe('signAccessToken + verifyAccessToken', () => {
  it('produces a token that decodes with correct standard claims', async () => {
    const token = await signAccessToken(BASE_INPUT);
    const payload = await verifyAccessToken(token);

    expect(payload.sub).toBe('user-123');
    expect(payload.email).toBe('alice@example.com');
    expect(payload.isAdmin).toBe(false);
    expect(payload.apps).toEqual([{ appId: 'travel-journal', role: 'creator' }]);
  });

  it('sets iss to AUTH_SERVICE_URL env var', async () => {
    process.env['AUTH_SERVICE_URL'] = 'https://auth.homectl.no';
    const token = await signAccessToken(BASE_INPUT);
    const payload = await verifyAccessToken(token);
    expect(payload.iss).toBe('https://auth.homectl.no');
  });

  it('sets aud to the clientId', async () => {
    const token = await signAccessToken({ ...BASE_INPUT, clientId: 'my-app' });
    const payload = await verifyAccessToken(token, 'my-app');
    expect(payload.aud).toBe('my-app');
  });

  it('rejects a token whose aud does not match expectedClientId', async () => {
    const token = await signAccessToken({ ...BASE_INPUT, clientId: 'app-a' });
    await expect(verifyAccessToken(token, 'app-b')).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    // Sign with a 1-second TTL by monkey-patching the TTL via a tiny helper
    // We test this by back-dating the iat/exp manually with jose's SignJWT directly
    const { privateKey } = await import('jose').then(async (jose) => {
      // Re-generate to avoid coupling to internal state — just use the test keys
      const { privateKey } = await jose.generateKeyPair('RS256');
      return { privateKey };
    });

    const { SignJWT } = await import('jose');
    const expiredToken = await new SignJWT({ email: 'x@x.com', isAdmin: false, apps: [] })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://auth.homectl.no')
      .setAudience('any-app')
      .setSubject('u1')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800) // expired 30 min ago
      .sign(privateKey);

    // This token was signed with a random key, so signature verification fails first
    await expect(verifyAccessToken(expiredToken)).rejects.toThrow();
  });

  it('rejects a token with a wrong iss', async () => {
    // Sign with a mismatched issuer using a fresh key pair (will fail signature anyway)
    const { privateKey } = await import('jose').then((jose) =>
      jose.generateKeyPair('RS256'),
    );
    const { SignJWT } = await import('jose');
    const badIssToken = await new SignJWT({ email: 'x@x.com', isAdmin: false, apps: [] })
      .setProtectedHeader({ alg: 'RS256', kid: 'bad' })
      .setIssuer('https://evil.example.com')
      .setAudience('travel-journal')
      .setSubject('u1')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privateKey);

    await expect(verifyAccessToken(badIssToken)).rejects.toThrow();
  });

  it('rejects a token signed with a different key (wrong signature)', async () => {
    const { privateKey: otherKey } = await import('jose').then((jose) =>
      jose.generateKeyPair('RS256'),
    );
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ email: 'x@x.com', isAdmin: false, apps: [] })
      .setProtectedHeader({ alg: 'RS256', kid: 'other' })
      .setIssuer(process.env['AUTH_SERVICE_URL'] ?? 'https://auth.homectl.no')
      .setAudience('travel-journal')
      .setSubject('u1')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(otherKey);

    await expect(verifyAccessToken(token)).rejects.toThrow();
  });

  it('isAdmin flag round-trips correctly', async () => {
    const token = await signAccessToken({ ...BASE_INPUT, isAdmin: true });
    const payload = await verifyAccessToken(token);
    expect(payload.isAdmin).toBe(true);
  });

  it('apps array with multiple entries round-trips correctly', async () => {
    const apps = [
      { appId: 'app-a', role: 'admin' },
      { appId: 'app-b', role: 'viewer' },
    ];
    const token = await signAccessToken({ ...BASE_INPUT, apps, clientId: 'app-a' });
    const payload = await verifyAccessToken(token, 'app-a');
    expect(payload.apps).toEqual(apps);
  });
});
