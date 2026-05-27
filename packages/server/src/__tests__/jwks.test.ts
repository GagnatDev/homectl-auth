import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../app';
import { generateTestKeys, resetKeys } from '../modules/token/token.service';

const app = createApp();

beforeAll(async () => {
  await generateTestKeys();
});

afterAll(() => {
  resetKeys();
});

describe('GET /.well-known/jwks.json', () => {
  it('returns 200 with a keys array', async () => {
    const res = await request(app).get('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('keys');
    expect(Array.isArray(res.body.keys)).toBe(true);
    expect(res.body.keys.length).toBeGreaterThan(0);
  });

  it('returned key has required JWKS fields', async () => {
    const res = await request(app).get('/.well-known/jwks.json');
    const key = res.body.keys[0];
    expect(key).toHaveProperty('kty', 'RSA');
    expect(key).toHaveProperty('use', 'sig');
    expect(key).toHaveProperty('alg', 'RS256');
    expect(key).toHaveProperty('kid');
    expect(key).toHaveProperty('n');
    expect(key).toHaveProperty('e');
  });

  it('key can be used to verify a token issued by this service', async () => {
    const { importJWK, jwtVerify } = await import('jose');

    // Get the JWKS
    const res = await request(app).get('/.well-known/jwks.json');
    const jwk = res.body.keys[0];
    const publicKey = await importJWK(jwk, 'RS256');

    // Sign a token using the test private key
    const { signAccessToken } = await import('../modules/token/token.service');
    const token = await signAccessToken({
      sub: 'u1',
      email: 'test@example.com',
      isAdmin: false,
      apps: [],
      clientId: 'test-app',
    });

    // Verify with the JWKS-derived public key
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ['RS256'],
    });

    expect(payload['sub']).toBe('u1');
    expect(payload['email']).toBe('test@example.com');
  });
});
