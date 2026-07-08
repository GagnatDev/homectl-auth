/**
 * CSRF `state` for the authorization-code flow.
 *
 * Before redirecting to /authorize the sidecar mints a random nonce, remembers
 * where the browser was headed, and stores both in a short-lived, HMAC-signed
 * cookie. On callback it checks the `state` query param echoed back by the auth
 * service against the nonce in the cookie. A signature mismatch or a nonce
 * mismatch is rejected, so a forged callback cannot establish a session.
 */

import { randomBytes, createHmac, timingSafeEqual } from 'crypto';

export const STATE_COOKIE_NAME = 'hs_state';
/** State cookies are single-use and short-lived. */
export const STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

export type StatePayload = {
  nonce: string;
  returnTo: string;
};

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

function sign(b64: string, key: Buffer): string {
  return createHmac('sha256', key).update(b64).digest('hex');
}

/** Sign a state payload into a `base64url(json).hexsig` cookie value. */
export function signState(payload: StatePayload, key: Buffer): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64, key)}`;
}

/** Verify and decode a state cookie. Returns null on any tampering. */
export function verifyState(value: string | undefined, key: Buffer): StatePayload | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts as [string, string];

  const expected = sign(b64, key);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as StatePayload;
    if (typeof parsed.nonce !== 'string' || typeof parsed.returnTo !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
