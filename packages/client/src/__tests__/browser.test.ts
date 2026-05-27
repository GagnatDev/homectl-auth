/**
 * Unit tests for @gagnatdev/homectl-auth-client/browser
 *
 * Uses vitest's built-in fetch mock to simulate the auth service responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAuthBrowserClient } from '../browser';

const AUTH_SERVICE_URL = 'https://auth.test.example.com';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeRefreshResponse(token: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, token_type: 'Bearer', expires_in: 900 }),
  };
}

function make401Response() {
  return {
    ok: false,
    status: 401,
    json: async () => ({ error: 'unauthorized' }),
  };
}

function make200Response(body: unknown = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ── bootstrap() ───────────────────────────────────────────────────────────

describe('bootstrap()', () => {
  it('stores and returns access token on 200 from /refresh', async () => {
    mockFetch.mockResolvedValueOnce(makeRefreshResponse('token-abc'));
    const client = createAuthBrowserClient({ authServiceUrl: AUTH_SERVICE_URL });

    const token = await client.bootstrap();

    expect(token).toBe('token-abc');
    expect(client.getAccessToken()).toBe('token-abc');
    expect(mockFetch).toHaveBeenCalledWith(
      `${AUTH_SERVICE_URL}/refresh`,
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('returns null and clears token on 401 from /refresh', async () => {
    mockFetch.mockResolvedValueOnce(make401Response());
    const client = createAuthBrowserClient({ authServiceUrl: AUTH_SERVICE_URL });

    const token = await client.bootstrap();

    expect(token).toBeNull();
    expect(client.getAccessToken()).toBeNull();
  });

  it('returns null on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const client = createAuthBrowserClient({ authServiceUrl: AUTH_SERVICE_URL });

    const token = await client.bootstrap();

    expect(token).toBeNull();
  });
});

// ── getAccessToken() ──────────────────────────────────────────────────────

describe('getAccessToken()', () => {
  it('returns null before bootstrap', () => {
    const client = createAuthBrowserClient({ authServiceUrl: AUTH_SERVICE_URL });
    expect(client.getAccessToken()).toBeNull();
  });

  it('returns token after successful bootstrap', async () => {
    mockFetch.mockResolvedValueOnce(makeRefreshResponse('my-token'));
    const client = createAuthBrowserClient({ authServiceUrl: AUTH_SERVICE_URL });
    await client.bootstrap();
    expect(client.getAccessToken()).toBe('my-token');
  });
});

// ── authedFetch() ─────────────────────────────────────────────────────────

describe('authedFetch()', () => {
  it('attaches Authorization header with current token', async () => {
    mockFetch.mockResolvedValueOnce(makeRefreshResponse('tok-1'));
    const client = createAuthBrowserClient({ authServiceUrl: AUTH_SERVICE_URL });
    await client.bootstrap();

    mockFetch.mockResolvedValueOnce(make200Response({ data: 'hello' }));
    await client.authedFetch('/api/data');

    const [, init] = mockFetch.mock.calls[1]!;
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('retries once on 401 after refreshing', async () => {
    // bootstrap → token-a
    mockFetch.mockResolvedValueOnce(makeRefreshResponse('token-a'));
    const client = createAuthBrowserClient({ authServiceUrl: AUTH_SERVICE_URL });
    await client.bootstrap();

    // first API call → 401
    mockFetch.mockResolvedValueOnce(make401Response());
    // refresh → token-b
    mockFetch.mockResolvedValueOnce(makeRefreshResponse('token-b'));
    // retry API call → 200
    mockFetch.mockResolvedValueOnce(make200Response({ ok: true }));

    const res = await client.authedFetch('/api/data');

    expect(res.status).toBe(200);
    // Verify last call used the new token
    const [, lastInit] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]!;
    expect((lastInit.headers as Headers).get('Authorization')).toBe('Bearer token-b');
  });

  it('surfaces 401 on second failure (does not retry indefinitely)', async () => {
    mockFetch.mockResolvedValueOnce(makeRefreshResponse('tok'));
    const client = createAuthBrowserClient({ authServiceUrl: AUTH_SERVICE_URL });
    await client.bootstrap();

    // first API call → 401
    mockFetch.mockResolvedValueOnce(make401Response());
    // refresh fails → null
    mockFetch.mockResolvedValueOnce(make401Response());

    const res = await client.authedFetch('/api/data');
    // bootstrap returned null, so we get the 401 response back
    expect(res.status).toBe(401);
  });
});

// ── logout() ──────────────────────────────────────────────────────────────

describe('logout()', () => {
  it('calls POST /logout and clears the in-memory token', async () => {
    mockFetch.mockResolvedValueOnce(makeRefreshResponse('tok-clear'));
    const client = createAuthBrowserClient({ authServiceUrl: AUTH_SERVICE_URL });
    await client.bootstrap();
    expect(client.getAccessToken()).toBe('tok-clear');

    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });
    await client.logout();

    expect(client.getAccessToken()).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith(
      `${AUTH_SERVICE_URL}/logout`,
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('clears token even when logout request fails', async () => {
    mockFetch.mockResolvedValueOnce(makeRefreshResponse('tok-fail'));
    const client = createAuthBrowserClient({ authServiceUrl: AUTH_SERVICE_URL });
    await client.bootstrap();

    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    // Should not throw
    await expect(client.logout()).resolves.toBeUndefined();

    expect(client.getAccessToken()).toBeNull();
  });
});
