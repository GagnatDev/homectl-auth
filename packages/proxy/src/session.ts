/**
 * Sidecar session — an AES-256-GCM encrypted, HttpOnly cookie.
 *
 * The session is the sidecar's entire state: because it lives in the cookie
 * (not on the pod) any replica can serve any request, so long as every replica
 * shares the same COOKIE_KEY. No Redis, no sticky sessions.
 *
 * The cookie holds the rotating refresh token, the cached access token (so
 * refreshes are rare), the access-token expiry, and the identity claims we
 * inject upstream. The GCM authentication tag makes a tampered cookie fail to
 * open rather than decode to attacker-controlled data.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

export type Session = {
  /** Opaque rotating refresh token — rotated on every /internal/refresh. */
  refreshToken: string;
  /** Cached RS256 access token. */
  accessToken: string;
  /** Access-token expiry, epoch seconds (the JWT `exp`). */
  accessExp: number;
  /** User id (JWT `sub`). */
  sub: string;
  email: string;
  /** The user's role in this app, or null if none. */
  role: string | null;
};

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Encrypt a session into a compact `iv.tag.body` base64url string.
 * `key` must be exactly 32 bytes.
 */
export function seal(session: Session, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(session), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, body].map((b) => b.toString('base64url')).join('.');
}

/**
 * Decrypt and authenticate a sealed session. Returns null for a missing,
 * malformed, or tampered value (never throws).
 */
export function open(value: string | undefined, key: Buffer): Session | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;

  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (!iv || !tag || !body || iv.length !== IV_BYTES) return null;

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext) as Session;

    // Shape check — a valid GCM tag guarantees we wrote it, but guard anyway.
    if (
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.accessExp !== 'number' ||
      typeof parsed.sub !== 'string' ||
      typeof parsed.email !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
