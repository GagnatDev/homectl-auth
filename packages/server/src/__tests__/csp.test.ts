import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';
import { setupTestAppConfig, TEST_APP } from './helpers/test-app-config';

// The auth service is an OAuth provider: /login 302s the credential POST to a
// consuming app's redirect_uri on a different origin. helmet's default CSP
// `form-action 'self'` would block that cross-origin submit in the browser, so
// the origins of the registered apps' redirect URIs must be present in the
// form-action directive.
const app = createApp();

describe('Content-Security-Policy form-action', () => {
  beforeAll(async () => {
    await setupTestAppConfig();
  });

  it('allows the redirect URIs origins so cross-origin login redirects are not blocked', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'] ?? '';

    const formAction = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('form-action'));

    expect(formAction).toBeDefined();
    expect(formAction).toContain("'self'");
    for (const uri of TEST_APP.allowedRedirectUris) {
      expect(formAction).toContain(new URL(uri).origin);
    }
  });
});
