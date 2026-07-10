import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../app';
import { generateTestKeys, resetKeys } from '../modules/token/token.service';
import { getPool } from '../db';
import { hashPassword } from '../modules/user/password.service';
import { findUserByEmail } from '../modules/user/user.repository';
import { getAccessForUser } from '../modules/app-access/app-access.repository';
import {
  setupTestAppConfig,
  TEST_APP_ID,
  TEST_CLIENT_SECRET,
  createTestUser,
  truncateTables,
} from './helpers/test-app-config';

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

// A precomputed cost-12 bcrypt hash is fine, but hashing here keeps the test
// self-describing and proves the stored hash still verifies.
async function importBody(users: unknown[]): Promise<Record<string, unknown>> {
  return { client_id: TEST_APP_ID, client_secret: TEST_CLIENT_SECRET, users };
}

describe('POST /internal/users/import', () => {
  it('creates a user, stores the hash verbatim, and grants access to the calling app', async () => {
    const passwordHash = await hashPassword('MigratedPass1!');

    const res = await request(app)
      .post('/internal/users/import')
      .send(
        await importBody([
          { email: 'alice@example.com', username: 'alice', passwordHash, role: 'editor' },
        ]),
      );

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 1, created: 1, skipped: 0, invalid: 0, granted: 1 });
    expect(res.body.results[0]).toMatchObject({ status: 'created', email: 'alice@example.com', role: 'editor', granted: true });

    const user = await findUserByEmail('alice@example.com');
    expect(user).not.toBeNull();
    // Hash stored verbatim — no re-hashing.
    expect(user!.passwordHash).toBe(passwordHash);
    expect(user!.isAdmin).toBe(false);

    const access = await getAccessForUser(user!.id);
    expect(access).toEqual([expect.objectContaining({ appId: TEST_APP_ID, role: 'editor' })]);
  });

  it('defaults the role to the app lowest rank when omitted', async () => {
    const passwordHash = await hashPassword('SomePass1!');

    const res = await request(app)
      .post('/internal/users/import')
      .send(await importBody([{ email: 'plainuser@example.com', username: 'plainuser', passwordHash }]));

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'created', role: 'viewer', granted: true });

    const user = await findUserByEmail('plainuser@example.com');
    const access = await getAccessForUser(user!.id);
    expect(access[0]!.role).toBe('viewer');
  });

  it('ignores any isAdmin in the payload — imported users are never operator admins', async () => {
    const passwordHash = await hashPassword('AdminPass1!');

    const res = await request(app)
      .post('/internal/users/import')
      // isAdmin: true must NOT elevate the imported user to a service admin.
      .send(await importBody([{ email: 'boss@example.com', username: 'boss', isAdmin: true, passwordHash }]));

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'created' });

    const user = await findUserByEmail('boss@example.com');
    expect(user!.isAdmin).toBe(false);
  });

  it('is idempotent: re-importing the same email skips without overwriting, but ensures access', async () => {
    const original = await createTestUser({ email: 'carol@example.com', username: 'carol', isAdmin: false });

    // Different hash + isAdmin on the re-import — must NOT be applied.
    const otherHash = await hashPassword('DifferentPass1!');
    const res = await request(app)
      .post('/internal/users/import')
      .send(
        await importBody([
          { email: 'carol@example.com', username: 'carol-new', isAdmin: true, passwordHash: otherHash, role: 'admin' },
        ]),
      );

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ created: 0, skipped: 1, granted: 1 });
    expect(res.body.results[0]).toMatchObject({ status: 'skipped', userId: original.id, granted: true });

    const user = await findUserByEmail('carol@example.com');
    // Credentials + admin flag untouched.
    expect(user!.passwordHash).toBe(original.passwordHash);
    expect(user!.isAdmin).toBe(false);
    expect(user!.username).toBe('carol');
    // But access to the calling app is granted.
    const access = await getAccessForUser(user!.id);
    expect(access).toEqual([expect.objectContaining({ appId: TEST_APP_ID, role: 'admin' })]);
  });

  it('leaves an existing admin as admin — import never demotes an operator', async () => {
    const admin = await createTestUser({ email: 'op@example.com', username: 'op', isAdmin: true });
    const passwordHash = await hashPassword('Whatever1!');

    const res = await request(app)
      .post('/internal/users/import')
      .send(await importBody([{ email: 'op@example.com', username: 'op', passwordHash, role: 'viewer' }]));

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'skipped', userId: admin.id });

    const user = await findUserByEmail('op@example.com');
    // Existing operator admin flag is preserved untouched.
    expect(user!.isAdmin).toBe(true);
  });

  it('allows a duplicate username as long as the email is unique (email is the identity key)', async () => {
    await createTestUser({ email: 'existing@example.com', username: 'shared' });
    const passwordHash = await hashPassword('Pass1234!');

    const res = await request(app)
      .post('/internal/users/import')
      .send(
        await importBody([
          { email: 'fresh@example.com', username: 'shared', passwordHash },
          { email: 'good@example.com', username: 'good', passwordHash },
        ]),
      );

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 2, created: 2 });
    expect(res.body.results[0]).toMatchObject({ status: 'created', username: 'shared' });
    expect(res.body.results[1]).toMatchObject({ status: 'created' });

    const created = await findUserByEmail('fresh@example.com');
    expect(created).not.toBeNull();
    expect(created!.username).toBe('shared');
  });

  it('rejects a non-bcrypt password hash per entry', async () => {
    const res = await request(app)
      .post('/internal/users/import')
      .send(await importBody([{ email: 'plain@example.com', username: 'plain', passwordHash: 'not-a-hash' }]));

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'invalid', error: expect.stringContaining('bcrypt') });
    expect(await findUserByEmail('plain@example.com')).toBeNull();
  });

  it('rejects an unknown role per entry', async () => {
    const passwordHash = await hashPassword('Pass1234!');
    const res = await request(app)
      .post('/internal/users/import')
      .send(await importBody([{ email: 'r@example.com', username: 'r', passwordHash, role: 'superadmin' }]));

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'invalid', error: expect.stringContaining('role') });
    expect(await findUserByEmail('r@example.com')).toBeNull();
  });

  it('flags entries missing required fields', async () => {
    const passwordHash = await hashPassword('Pass1234!');
    const res = await request(app)
      .post('/internal/users/import')
      .send(await importBody([{ email: 'noname@example.com', passwordHash }]));

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'invalid' });
  });

  it('rejects a bad client secret with 401 invalid_client and imports nothing', async () => {
    const passwordHash = await hashPassword('Pass1234!');
    const res = await request(app).post('/internal/users/import').send({
      client_id: TEST_APP_ID,
      client_secret: 'wrong',
      users: [{ email: 'x@example.com', username: 'x', passwordHash }],
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(await findUserByEmail('x@example.com')).toBeNull();
  });

  it('rejects an unknown client with 401 invalid_client', async () => {
    const res = await request(app).post('/internal/users/import').send({
      client_id: 'no-such-app',
      client_secret: TEST_CLIENT_SECRET,
      users: [],
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('returns 400 when required top-level fields are missing', async () => {
    const res = await request(app)
      .post('/internal/users/import')
      .send({ client_id: TEST_APP_ID, client_secret: TEST_CLIENT_SECRET });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('returns 400 when users is not an array', async () => {
    const res = await request(app)
      .post('/internal/users/import')
      .send({ client_id: TEST_APP_ID, client_secret: TEST_CLIENT_SECRET, users: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('does not set a cookie (pure server-to-server)', async () => {
    const passwordHash = await hashPassword('Pass1234!');
    const res = await request(app)
      .post('/internal/users/import')
      .send(await importBody([{ email: 'nc@example.com', username: 'nc', passwordHash }]));
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
