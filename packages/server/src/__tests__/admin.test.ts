import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../app';
import {
  generateTestKeys,
  resetKeys,
  signAccessToken,
} from '../modules/token/token.service';
import {
  setupTestAppConfig,
  TEST_APP_ID,
  createTestUser,
  createTestUserWithAccess,
  truncateTables,
} from './helpers/test-app-config';
import { findAccess } from '../modules/app-access/app-access.repository';

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

async function nonAdminToken(): Promise<string> {
  const user = await createTestUser({ email: 'regular@example.com', username: 'regular' });
  return signAccessToken({
    sub: user.id,
    email: user.email,
    isAdmin: false,
    apps: [],
    clientId: TEST_APP_ID,
  });
}

// ── Admin guards ───────────────────────────────────────────────────────────

describe('Admin route guards', () => {
  it('GET /admin/api/users returns 401 with no token', async () => {
    const res = await request(app).get('/admin/api/users');
    expect(res.status).toBe(401);
  });

  it('GET /admin/api/users returns 403 with non-admin token', async () => {
    const token = await nonAdminToken();
    const res = await request(app)
      .get('/admin/api/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('GET /admin/api/users returns 200 with admin token', async () => {
    const token = await adminToken();
    const res = await request(app)
      .get('/admin/api/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── User list ──────────────────────────────────────────────────────────────

describe('GET /admin/api/users', () => {
  it('returns all users with app access summary', async () => {
    const token = await adminToken();
    const u1 = await createTestUserWithAccess(TEST_APP_ID, 'viewer');
    const u2 = await createTestUser({ email: 'u2@example.com', username: 'u2' });

    const res = await request(app)
      .get('/admin/api/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // At least the two users + admin (created by adminToken)
    expect(res.body.length).toBeGreaterThanOrEqual(3);

    const found = res.body.find((u: { id: string }) => u.id === u1.id);
    expect(found).toBeTruthy();
    expect(found.appAccess).toContainEqual({ appId: TEST_APP_ID, role: 'viewer' });
  });
});

// ── Grant + revoke access ──────────────────────────────────────────────────

describe('POST /admin/api/users/:id/access', () => {
  it('grants app access to a user', async () => {
    const token = await adminToken();
    const user = await createTestUser();

    const res = await request(app)
      .post(`/admin/api/users/${user.id}/access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ appId: TEST_APP_ID, role: 'viewer' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('viewer');

    const access = await findAccess(user.id, TEST_APP_ID);
    expect(access?.role).toBe('viewer');
  });
});

describe('DELETE /admin/api/users/:id/access/:appId', () => {
  it('revokes app access', async () => {
    const token = await adminToken();
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');

    const res = await request(app)
      .delete(`/admin/api/users/${user.id}/access/${TEST_APP_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);

    const access = await findAccess(user.id, TEST_APP_ID);
    expect(access).toBeNull();
  });
});

// ── Admin invite creation ──────────────────────────────────────────────────

describe('POST /admin/api/invites', () => {
  it('returns invite token and link', async () => {
    const token = await adminToken();

    const res = await request(app)
      .post('/admin/api/invites')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'newuser@example.com', appGrants: [{ appId: TEST_APP_ID, role: 'viewer' }] });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('link');
    expect(res.body.link).toContain('/invite?token=');
  });
});

// ── Admin password reset ───────────────────────────────────────────────────

describe('POST /admin/api/users/:id/password-reset', () => {
  it('returns reset token and link for existing user', async () => {
    const adminTok = await adminToken();
    const user = await createTestUser();

    const res = await request(app)
      .post(`/admin/api/users/${user.id}/password-reset`)
      .set('Authorization', `Bearer ${adminTok}`);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('token');
    expect(res.body.link).toContain('/reset-password?token=');
  });

  it('returns 404 for unknown user', async () => {
    const token = await adminToken();

    const res = await request(app)
      .post('/admin/api/users/00000000-0000-0000-0000-000000000001/password-reset')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ── htmx fragment responses (HX-Request header) ─────────────────────────────
//
// The admin GUI drives these endpoints with htmx, which expects an HTML fragment
// to swap into the page rather than JSON. The HX-Request header is the signal.

describe('htmx fragment responses', () => {
  it('grant access returns the updated access-table fragment', async () => {
    const token = await adminToken();
    const user = await createTestUser();

    const res = await request(app)
      .post(`/admin/api/users/${user.id}/access`)
      .set('Authorization', `Bearer ${token}`)
      .set('HX-Request', 'true')
      .send({ appId: TEST_APP_ID, role: 'viewer' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('id="access-table"');
    expect(res.text).toContain(`id="access-${TEST_APP_ID}"`);
    expect(res.text).toContain('viewer');
  });

  it('revoke access returns an empty 200 so htmx removes the row', async () => {
    const token = await adminToken();
    const user = await createTestUserWithAccess(TEST_APP_ID, 'editor');

    const res = await request(app)
      .delete(`/admin/api/users/${user.id}/access/${TEST_APP_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .set('HX-Request', 'true');

    expect(res.status).toBe(200);
    expect(res.text).toBe('');

    const access = await findAccess(user.id, TEST_APP_ID);
    expect(access).toBeNull();
  });

  it('password reset returns the reset-link fragment', async () => {
    const token = await adminToken();
    const user = await createTestUser();

    const res = await request(app)
      .post(`/admin/api/users/${user.id}/password-reset`)
      .set('Authorization', `Bearer ${token}`)
      .set('HX-Request', 'true');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('/reset-password?token=');
  });

  it('invite creation renders the page when HTML is preferred', async () => {
    const token = await adminToken();

    const res = await request(app)
      .post('/admin/api/invites')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'text/html')
      .type('form')
      .send({ email: 'gui@example.com', 'appGrants[0][appId]': TEST_APP_ID, 'appGrants[0][role]': 'viewer' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('/invite?token=');
  });
});
