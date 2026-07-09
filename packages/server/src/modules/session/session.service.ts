/**
 * Session Module
 *
 * Issues and manages opaque refresh tokens (32 random bytes, hex-encoded).
 * Stores the SHA-256 hash in Postgres — never the raw token.
 *
 * Cookie names:
 *   - homectl_refresh_<clientId>  per-app refresh token
 *   - homectl_sso                 single-sign-on (records authenticated user ID)
 *
 * Refresh cookies: HttpOnly; Secure; SameSite=Strict; path=/; domain=.homectl.no
 * (parent domain so app subdomains like workbench.homectl.no receive them).
 * SSO cookie: same flags but host-only on auth.homectl.no.
 */

import { randomBytes, createHash } from 'crypto';
import { getPool } from '../../db';
import { type Response } from 'express';

const REFRESH_TTL_DAYS = 30;
const SSO_TTL_DAYS = 30;

/** Parent domain for per-app refresh cookies (override via REFRESH_COOKIE_DOMAIN). */
export function getRefreshCookieDomain(): string | undefined {
  return (
    process.env['REFRESH_COOKIE_DOMAIN'] ??
    (process.env['NODE_ENV'] === 'production' ? '.homectl.no' : undefined)
  );
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function refreshCookieName(clientId: string): string {
  return `homectl_refresh_${clientId}`;
}

export const SSO_COOKIE_NAME = 'homectl_sso';

function baseCookieOptions(ttlDays: number) {
  return {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: ttlDays * 24 * 60 * 60 * 1000,
  };
}

function refreshCookieOptions(ttlDays: number) {
  const domain = getRefreshCookieDomain();
  return {
    ...baseCookieOptions(ttlDays),
    ...(domain ? { domain } : {}),
  };
}

export function refreshCookieClearOptions() {
  const domain = getRefreshCookieDomain();
  return {
    path: '/',
    ...(domain ? { domain } : {}),
  };
}

// ── DB operations ──────────────────────────────────────────────────────────

export type Session = {
  id: string;
  tokenHash: string;
  userId: string;
  clientId: string;
  expiresAt: Date;
  createdAt: Date;
};

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row['id'] as string,
    tokenHash: row['token_hash'] as string,
    userId: row['user_id'] as string,
    clientId: row['client_id'] as string,
    expiresAt: row['expires_at'] as Date,
    createdAt: row['created_at'] as Date,
  };
}

export async function createSession(userId: string, clientId: string): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

  await getPool().query(
    `INSERT INTO homectl_auth.sessions (token_hash, user_id, client_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [tokenHash, userId, clientId, expiresAt],
  );

  return raw;
}

/**
 * Rotate a refresh token: atomically invalidate the old one and issue a new one.
 * Returns the new raw token, or null if the old token was not found / expired.
 */
export async function rotateSession(
  oldRawToken: string,
  clientId: string,
): Promise<{ newToken: string; userId: string } | null> {
  const oldHash = hashToken(oldRawToken);

  // Delete old session and return its data in one round-trip
  const { rows } = await getPool().query<Record<string, unknown>>(
    `DELETE FROM homectl_auth.sessions
     WHERE token_hash = $1 AND client_id = $2
     RETURNING user_id, expires_at`,
    [oldHash, clientId],
  );

  if (!rows[0]) return null;

  const session = rows[0];
  const expiresAt = session['expires_at'] as Date;
  if (expiresAt < new Date()) return null;

  const userId = session['user_id'] as string;

  // Issue new token
  const newToken = await createSession(userId, clientId);
  return { newToken, userId };
}

/**
 * Delete the session for a specific client_id associated with the given raw token.
 */
export async function deleteSessionByToken(rawToken: string, clientId: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await getPool().query(
    'DELETE FROM homectl_auth.sessions WHERE token_hash = $1 AND client_id = $2',
    [tokenHash, clientId],
  );
}

/**
 * Find a session by raw token + clientId. Returns null if not found or expired.
 */
export async function findSession(
  rawToken: string,
  clientId: string,
): Promise<Session | null> {
  const tokenHash = hashToken(rawToken);
  const { rows } = await getPool().query<Record<string, unknown>>(
    'SELECT * FROM homectl_auth.sessions WHERE token_hash = $1 AND client_id = $2',
    [tokenHash, clientId],
  );
  if (!rows[0]) return null;
  const session = rowToSession(rows[0]);
  if (session.expiresAt < new Date()) return null;
  return session;
}

/**
 * Delete all sessions for a user (used after password reset).
 */
export async function deleteAllSessionsForUser(userId: string): Promise<void> {
  await getPool().query('DELETE FROM homectl_auth.sessions WHERE user_id = $1', [userId]);
}

// ── Cookie helpers ─────────────────────────────────────────────────────────

export function setRefreshCookie(res: Response, clientId: string, rawToken: string): void {
  res.cookie(refreshCookieName(clientId), rawToken, refreshCookieOptions(REFRESH_TTL_DAYS));
}

export function clearRefreshCookie(res: Response, clientId: string): void {
  res.clearCookie(refreshCookieName(clientId), refreshCookieClearOptions());
}

export function setSsoCookie(res: Response, userId: string): void {
  res.cookie(SSO_COOKIE_NAME, userId, baseCookieOptions(SSO_TTL_DAYS));
}

export function getRefreshTokenFromCookie(
  cookies: Record<string, string>,
  clientId: string,
): string | undefined {
  return cookies[refreshCookieName(clientId)];
}

export function getSsoCookieValue(cookies: Record<string, string>): string | undefined {
  return cookies[SSO_COOKIE_NAME];
}
