/**
 * Configuration for the forward-auth sidecar.
 *
 * Every setting comes from an environment variable (see the table in
 * docs/sidecar/integration.md). Config is validated once at startup with zod;
 * a missing or malformed value produces a single fatal error listing every
 * problem, so misconfiguration fails fast and loudly rather than at first
 * request.
 */

import { z } from 'zod';

export type DevIdentity = {
  sub: string;
  email: string;
  role: string | null;
};

export type ProxyConfig = {
  /** Public base URL of homectl-auth — browser redirect target and JWT `iss`. */
  publicAuthUrl: string;
  /** In-cluster base URL for /token, /internal/refresh and JWKS. */
  internalAuthUrl: string;
  /** Registered app id (JWT `aud`). */
  clientId: string;
  /** Plaintext client secret for /token + /internal/refresh. */
  clientSecret: string;
  /** Public base URL of the consuming app; builds the redirect_uri. */
  appBaseUrl: string;
  /** The app container in the same pod (proxy target). */
  upstream: string;
  /** 32-byte AES-256-GCM cookie key; identical across all replicas. */
  cookieKey: Buffer;
  /** Path the sidecar handles for the code exchange. */
  callbackPath: string;
  /** Path the sidecar handles for logout. */
  logoutPath: string;
  /** Port ingress targets. */
  listenPort: number;
  /** Refresh this many seconds before the access token expires. */
  refreshSkewSeconds: number;
  /** Sidecar session cookie name. */
  sessionCookieName: string;
  /** Full public redirect_uri (appBaseUrl + callbackPath). */
  redirectUri: string;
  /** Internal JWKS URL. */
  jwksUrl: string;
  /**
   * Dev-only fake identity. When set (and NODE_ENV !== 'production') the sidecar
   * skips the entire OAuth flow and injects this identity on every request, so
   * an app can be developed without a cluster. Fatal if set in production.
   */
  devIdentity: DevIdentity | null;
  isProduction: boolean;
};

/** Strip a trailing slash so `${url}/token` never doubles up. */
const url = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .trim()
    .min(1, `${name} is required`)
    .url(`${name} must be a valid URL`)
    .transform((v) => v.replace(/\/+$/, ''));

const path = (name: string, fallback: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .transform((v) => (v.startsWith('/') ? v : `/${v}`));

const cookieKey = z
  .string({ required_error: 'COOKIE_KEY is required' })
  .trim()
  .min(1, 'COOKIE_KEY is required')
  .refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    'COOKIE_KEY must be exactly 32 bytes, base64-encoded (generate with: openssl rand -base64 32)',
  )
  .transform((v) => Buffer.from(v, 'base64'));

const devIdentity = z
  .string()
  .optional()
  .transform((v, ctx): DevIdentity | null => {
    if (!v || v.trim() === '') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DEV_FAKE_IDENTITY must be valid JSON, e.g. {"sub":"dev","email":"dev@example.com","role":"admin"}',
      });
      return z.NEVER;
    }
    const shape = z.object({
      sub: z.string().min(1),
      email: z.string().min(1),
      role: z.string().nullable().default(null),
    });
    const result = shape.safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DEV_FAKE_IDENTITY must be an object with { sub, email, role? }',
      });
      return z.NEVER;
    }
    return result.data;
  });

const envSchema = z.object({
  PUBLIC_AUTH_URL: url('PUBLIC_AUTH_URL'),
  INTERNAL_AUTH_URL: url('INTERNAL_AUTH_URL'),
  AUTH_CLIENT_ID: z
    .string({ required_error: 'AUTH_CLIENT_ID is required' })
    .trim()
    .min(1, 'AUTH_CLIENT_ID is required'),
  AUTH_CLIENT_SECRET: z
    .string({ required_error: 'AUTH_CLIENT_SECRET is required' })
    .min(1, 'AUTH_CLIENT_SECRET is required'),
  APP_BASE_URL: url('APP_BASE_URL'),
  UPSTREAM: url('UPSTREAM'),
  COOKIE_KEY: cookieKey,
  CALLBACK_PATH: path('CALLBACK_PATH', '/auth/callback'),
  LOGOUT_PATH: path('LOGOUT_PATH', '/auth/logout'),
  LISTEN_PORT: z.coerce
    .number({ invalid_type_error: 'LISTEN_PORT must be a number' })
    .int()
    .positive()
    .default(4180),
  REFRESH_SKEW_SECONDS: z.coerce
    .number({ invalid_type_error: 'REFRESH_SKEW_SECONDS must be a number' })
    .int()
    .nonnegative()
    .default(60),
  SESSION_COOKIE_NAME: z.string().trim().min(1).default('hs_session'),
  NODE_ENV: z.string().optional(),
  DEV_FAKE_IDENTITY: devIdentity,
});

/**
 * Parse and validate configuration from an env-like record (defaults to
 * process.env). Throws an Error whose message lists every problem when invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = i.path.join('.') || '(root)';
      return `  - ${key}: ${i.message}`;
    });
    throw new Error(`Invalid homectl-auth-proxy configuration:\n${lines.join('\n')}`);
  }

  const v = parsed.data;
  const isProduction = v.NODE_ENV === 'production';

  if (v.DEV_FAKE_IDENTITY && isProduction) {
    throw new Error(
      'Invalid homectl-auth-proxy configuration:\n' +
        '  - DEV_FAKE_IDENTITY must never be set when NODE_ENV=production (it bypasses authentication)',
    );
  }

  return {
    publicAuthUrl: v.PUBLIC_AUTH_URL,
    internalAuthUrl: v.INTERNAL_AUTH_URL,
    clientId: v.AUTH_CLIENT_ID,
    clientSecret: v.AUTH_CLIENT_SECRET,
    appBaseUrl: v.APP_BASE_URL,
    upstream: v.UPSTREAM,
    cookieKey: v.COOKIE_KEY,
    callbackPath: v.CALLBACK_PATH,
    logoutPath: v.LOGOUT_PATH,
    listenPort: v.LISTEN_PORT,
    refreshSkewSeconds: v.REFRESH_SKEW_SECONDS,
    sessionCookieName: v.SESSION_COOKIE_NAME,
    redirectUri: `${v.APP_BASE_URL}${v.CALLBACK_PATH}`,
    jwksUrl: `${v.INTERNAL_AUTH_URL}/.well-known/jwks.json`,
    devIdentity: v.DEV_FAKE_IDENTITY,
    isProduction,
  };
}
