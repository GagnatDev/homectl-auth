/**
 * @gagnatdev/homectl-auth-client/browser
 *
 * Browser-side helper for homectl-auth.
 * Stores the access token in JS memory only (not localStorage/sessionStorage).
 *
 * Usage:
 *   import { createAuthBrowserClient } from '@gagnatdev/homectl-auth-client/browser';
 *
 *   const auth = createAuthBrowserClient({ authServiceUrl: 'https://auth.homectl.no' });
 *   const token = await auth.bootstrap(); // call once on app load
 *   if (!token) { redirectToLogin(); return; }
 *
 *   const data = await auth.authedFetch('/api/trips');
 */

export type AuthBrowserClientOptions = {
  /** Base URL of the auth service, e.g. https://auth.homectl.no */
  authServiceUrl: string;
};

export type AuthBrowserClient = {
  /**
   * Bootstrap: POST /refresh to get a fresh access token from the refresh cookie.
   * Returns the access token string on success, or null if unauthenticated.
   */
  bootstrap(): Promise<string | null>;
  /** Return the current in-memory access token, or null if not bootstrapped. */
  getAccessToken(): string | null;
  /**
   * Wrapper around fetch that attaches `Authorization: Bearer <token>`.
   * On 401, calls bootstrap() once and retries. On a second 401, throws.
   */
  authedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<globalThis.Response>;
  /** POST /logout to the auth service, clear in-memory token. */
  logout(): Promise<void>;
};

export function createAuthBrowserClient(
  options: AuthBrowserClientOptions,
): AuthBrowserClient {
  const { authServiceUrl } = options;
  let _token: string | null = null;

  async function bootstrap(): Promise<string | null> {
    try {
      const res = await fetch(`${authServiceUrl}/refresh`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!res.ok) {
        _token = null;
        return null;
      }

      const data = (await res.json()) as { access_token: string };
      _token = data.access_token;
      return _token;
    } catch {
      _token = null;
      return null;
    }
  }

  function getAccessToken(): string | null {
    return _token;
  }

  async function authedFetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<globalThis.Response> {
    if (!_token) {
      await bootstrap();
    }

    const headers = new Headers(init.headers);
    if (_token) {
      headers.set('Authorization', `Bearer ${_token}`);
    }

    const res = await fetch(input, { ...init, headers });

    if (res.status === 401) {
      // Try refreshing once
      const newToken = await bootstrap();
      if (!newToken) {
        return res; // surface the 401
      }

      headers.set('Authorization', `Bearer ${newToken}`);
      const retryRes = await fetch(input, { ...init, headers });
      return retryRes;
    }

    return res;
  }

  async function logout(): Promise<void> {
    try {
      await fetch(`${authServiceUrl}/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Network error — clear the in-memory token regardless
    } finally {
      _token = null;
    }
  }

  return { bootstrap, getAccessToken, authedFetch, logout };
}
