/**
 * The sidecar's client for homectl-auth.
 *
 * All server-to-server calls (code exchange, refresh, JWKS) go to the
 * *internal* ClusterIP URL so they never touch the public ingress. JWT
 * verification uses `jose` with exactly the same parameters as
 * `@gagnatdev/homectl-auth-client` (RS256, iss = PUBLIC_AUTH_URL, aud =
 * clientId), so verification behaviour can never drift from what library apps
 * enforce.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { ProxyConfig } from './config';

/** Identity + expiry extracted from a verified access token. */
export type TokenClaims = {
  sub: string;
  email: string;
  role: string | null;
  exp: number;
};

export type RefreshResult = {
  accessToken: string;
  /** The rotated refresh token — must be persisted (the old one is now dead). */
  refreshToken: string;
};

export type AuthClient = {
  /** Exchange an authorization code for an access token (server-to-server). */
  exchangeCode(code: string): Promise<string>;
  /** Rotate the refresh token and mint a fresh access token. */
  refresh(refreshToken: string): Promise<RefreshResult>;
  /** Verify an access token and extract identity claims. Throws if invalid. */
  verifyAccessToken(token: string): Promise<TokenClaims>;
  /** Readiness check — confirm the JWKS endpoint is reachable and well-formed. */
  checkJwks(): Promise<void>;
};

const FETCH_TIMEOUT_MS = 10_000;

async function postJson(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractClaims(payload: JWTPayload, clientId: string): TokenClaims {
  const apps = (payload['apps'] as Array<{ appId: string; role: string }>) ?? [];
  const entry = apps.find((a) => a.appId === clientId);
  return {
    sub: payload.sub as string,
    email: payload['email'] as string,
    role: entry?.role ?? null,
    exp: payload.exp as number,
  };
}

/**
 * Build an AuthClient. Pass `jwksProvider` in tests to verify against a local
 * key set without any network I/O.
 */
export function createAuthClient(config: ProxyConfig, jwksProvider?: JWTVerifyGetKey): AuthClient {
  const JWKS = jwksProvider ?? createRemoteJWKSet(new URL(config.jwksUrl));

  async function verifyAccessToken(token: string): Promise<TokenClaims> {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: config.publicAuthUrl,
      audience: config.clientId,
      algorithms: ['RS256'],
    });
    return extractClaims(payload, config.clientId);
  }

  async function exchangeCode(code: string): Promise<string> {
    const res = await postJson(`${config.internalAuthUrl}/token`, {
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    });
    if (!res.ok) {
      throw new Error(`token_exchange_failed_${res.status}`);
    }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new Error('token_exchange_missing_access_token');
    }
    return body.access_token;
  }

  async function refresh(refreshToken: string): Promise<RefreshResult> {
    const res = await postJson(`${config.internalAuthUrl}/internal/refresh`, {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    });
    if (!res.ok) {
      throw new Error(`refresh_failed_${res.status}`);
    }
    const body = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!body.access_token || !body.refresh_token) {
      throw new Error('refresh_missing_tokens');
    }
    return { accessToken: body.access_token, refreshToken: body.refresh_token };
  }

  async function checkJwks(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(config.jwksUrl, { signal: controller.signal });
      if (!res.ok) throw new Error(`jwks_unreachable_${res.status}`);
      const body = (await res.json()) as { keys?: unknown[] };
      if (!Array.isArray(body.keys) || body.keys.length === 0) {
        throw new Error('jwks_empty');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { exchangeCode, refresh, verifyAccessToken, checkJwks };
}
