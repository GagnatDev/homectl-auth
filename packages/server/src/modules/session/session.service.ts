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

/**
 * How long a just-rotated refresh token stays honourable.
 *
 * The stateless sidecar keeps its refresh token in a cookie, so a browser can
 * fire several requests carrying the SAME token that all cross the refresh
 * threshold together. Without tolerance the first refresh rotates the token and
 * every sibling request 401s — the sidecar then clears the session and forces a
 * re-login. Honouring the old token for a short window lets those concurrent
 * refreshes succeed; anything presenting it later is treated as replay.
 */
const ROTATION_GRACE_SECONDS = 30;

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
 * Rotate a refresh token: mark the presented token as rotated and issue a fresh
 * successor. Returns the new raw token, or null if the presented token was not
 * found, expired, or is a replay of a token rotated longer than the grace
 * window ago.
 *
 * Rotation does NOT delete the old row. It stamps it with `rotated_at` and
 * keeps it for `ROTATION_GRACE_SECONDS`, so concurrent requests that were
 * already in flight with the same token — before the first refresh's Set-Cookie
 * reached the browser — are honoured instead of being logged out. Each such
 * caller receives its own fresh successor; the browser keeps whichever cookie
 * arrives last and the extra rows are purged by the cleanup job. A token
 * presented after the grace window has elapsed is treated as replay (null).
 *
 * The presented row is locked FOR UPDATE so the first-use stamp is applied
 * exactly once even under concurrent refreshes.
 */
export async function rotateSession(
  oldRawToken: string,
  clientId: string,
): Promise<{ newToken: string; userId: string } | null> {
  const oldHash = hashToken(oldRawToken);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT user_id, expires_at, rotated_at
         FROM homectl_auth.sessions
        WHERE token_hash = $1 AND client_id = $2
        FOR UPDATE`,
      [oldHash, clientId],
    );

    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null; // unknown token
    }

    const expiresAt = row['expires_at'] as Date;
    if (expiresAt < new Date()) {
      await client.query('ROLLBACK');
      return null; // expired
    }

    const rotatedAt = row['rotated_at'] as Date | null;
    if (rotatedAt) {
      // Already rotated: honour only within the grace window, else it is replay.
      const graceCutoff = new Date(Date.now() - ROTATION_GRACE_SECONDS * 1000);
      if (rotatedAt < graceCutoff) {
        await client.query('ROLLBACK');
        return null;
      }
    } else {
      // First use: stamp (but keep) the presented token so siblings within the
      // grace window still resolve.
      await client.query(
        `UPDATE homectl_auth.sessions SET rotated_at = NOW()
          WHERE token_hash = $1 AND client_id = $2`,
        [oldHash, clientId],
      );
    }

    const userId = row['user_id'] as string;

    // Issue the successor token on the same connection so it commits atomically
    // with the rotation stamp.
    const raw = randomBytes(32).toString('hex');
    const newHash = hashToken(raw);
    const newExpiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO homectl_auth.sessions (token_hash, user_id, client_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [newHash, userId, clientId, newExpiresAt],
    );

    await client.query('COMMIT');
    return { newToken: raw, userId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
    `SELECT * FROM homectl_auth.sessions
      WHERE token_hash = $1 AND client_id = $2 AND rotated_at IS NULL`,
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
