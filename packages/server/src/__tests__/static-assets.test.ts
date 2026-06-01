import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const app = createApp();

// htmx is vendored and served from our own origin so the strict CSP
// (script-src 'self') needs no CDN exception. The admin views reference it at
// /static/htmx.min.js, so it must be served — unauthenticated — as JavaScript.
describe('GET /static/htmx.min.js', () => {
  it('serves the vendored htmx library as JavaScript without auth', async () => {
    const res = await request(app).get('/static/htmx.min.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('htmx');
  });
});
