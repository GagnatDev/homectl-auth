import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';
import { setupTestAppConfig, TEST_APP_ID } from './helpers/test-app-config';

const app = createApp();

beforeAll(async () => {
  await setupTestAppConfig();
});

// The React SPA is served as a static shell for browser navigations; React
// Router resolves the route client-side. API paths never fall through to it.
describe('SPA shell serving', () => {
  it('serves the shell at /', async () => {
    const res = await request(app).get('/').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('id="root"');
  });

  it('serves the shell for an arbitrary client-side route (deep link)', async () => {
    const res = await request(app).get('/admin/users/abc-123').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('404s as JSON for an unknown API path rather than serving the shell', async () => {
    const res = await request(app).get('/api/does-not-exist').set('Accept', 'text/html');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

// ── Public endpoints the SPA reads ──────────────────────────────────────────

describe('GET /api/apps/:clientId', () => {
  it('returns the app id + name for a known client', async () => {
    const res = await request(app).get(`/api/apps/${TEST_APP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: TEST_APP_ID, name: 'Test App' });
  });

  it('404s for an unknown client', async () => {
    const res = await request(app).get('/api/apps/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_client');
  });
});

describe('GET /api/admin-login', () => {
  it('returns the GitHub authorize URL and sets the CSRF state cookie', async () => {
    process.env['GITHUB_ADMIN_CLIENT_ID'] = 'test-github-client-id';

    const res = await request(app).get('/api/admin-login');
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('github.com/login/oauth/authorize');
    expect(res.body.url).toContain('client_id=test-github-client-id');

    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie?.some((c) => c.startsWith('homectl_admin_oauth_state='))).toBe(true);
  });
});
