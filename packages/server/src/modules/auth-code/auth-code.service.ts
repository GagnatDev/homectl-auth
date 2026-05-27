/**
 * Authorization Code Module
 *
 * Issues short-lived single-use opaque codes for the authorization code flow.
 * Stores the SHA-256 hash of the code in Postgres (never the raw token).
 * Code exchange validates the client secret and then deletes the code atomically.
 */

import { randomBytes, createHash } from 'crypto';
import { getPool } from '../../db';
import { findAccess, getAccessForUser } from '../app-access/app-access.repository';
import { getApp, getClientSecretHash, validateRedirectUri } from '../../config/apps';
import { signAccessToken } from '../token/token.service';
import bcrypt from 'bcryptjs';

const CODE_TTL_SECONDS = 5 * 60; // 5 minutes

function hashCode(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export type IssueCodeInput = {
  userId: string;
  clientId: string;
  redirectUri: string;
};

export type IssueCodeResult = {
  code: string;
};

export async function issueCode(input: IssueCodeInput): Promise<IssueCodeResult> {
  const raw = randomBytes(32).toString('hex');
  const codeHash = hashCode(raw);
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);

  await getPool().query(
    `INSERT INTO homectl_auth.authorization_codes
       (code_hash, client_id, user_id, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [codeHash, input.clientId, input.userId, input.redirectUri, expiresAt],
  );

  return { code: raw };
}

export type ExchangeCodeError =
  | 'INVALID_CLIENT'
  | 'INVALID_CODE'
  | 'EXPIRED_CODE'
  | 'REDIRECT_URI_MISMATCH'
  | 'CLIENT_ID_MISMATCH';

export type ExchangeCodeInput = {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type ExchangeCodeResult = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
};

export type ExchangeCodeOutcome =
  | { ok: true; result: ExchangeCodeResult }
  | { ok: false; error: ExchangeCodeError };

export async function exchangeCode(input: ExchangeCodeInput): Promise<ExchangeCodeOutcome> {
  // 1. Validate client
  const app = getApp(input.clientId);
  if (!app) {
    return { ok: false, error: 'INVALID_CLIENT' };
  }

  let secretHash: string;
  try {
    secretHash = getClientSecretHash(app);
  } catch {
    return { ok: false, error: 'INVALID_CLIENT' };
  }

  const secretValid = await bcrypt.compare(input.clientSecret, secretHash);
  if (!secretValid) {
    return { ok: false, error: 'INVALID_CLIENT' };
  }

  // 2. Look up the code (by hash) — do NOT delete yet
  const codeHash = hashCode(input.code);
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT * FROM homectl_auth.authorization_codes WHERE code_hash = $1`,
    [codeHash],
  );

  const row = rows[0];
  if (!row) {
    return { ok: false, error: 'INVALID_CODE' };
  }

  // 3. Check expiry
  const expiresAt = row['expires_at'] as Date;
  if (expiresAt < new Date()) {
    // Clean up expired code
    await getPool().query(
      'DELETE FROM homectl_auth.authorization_codes WHERE code_hash = $1',
      [codeHash],
    );
    return { ok: false, error: 'EXPIRED_CODE' };
  }

  // 4. Check client_id match
  if ((row['client_id'] as string) !== input.clientId) {
    return { ok: false, error: 'CLIENT_ID_MISMATCH' };
  }

  // 5. Check redirect_uri match
  if ((row['redirect_uri'] as string) !== input.redirectUri) {
    return { ok: false, error: 'REDIRECT_URI_MISMATCH' };
  }

  // 6. Delete the code atomically — reject if it was already consumed
  const { rowCount } = await getPool().query(
    'DELETE FROM homectl_auth.authorization_codes WHERE code_hash = $1',
    [codeHash],
  );
  if (!rowCount || rowCount === 0) {
    return { ok: false, error: 'INVALID_CODE' };
  }

  // 7. Mint access token
  const userId = row['user_id'] as string;
  const appAccesses = await getAccessForUser(userId);

  const { rows: userRows } = await getPool().query<Record<string, unknown>>(
    'SELECT email, is_admin FROM homectl_auth.users WHERE id = $1',
    [userId],
  );
  const userRow = userRows[0];
  if (!userRow) {
    return { ok: false, error: 'INVALID_CODE' };
  }

  const accessToken = await signAccessToken({
    sub: userId,
    email: userRow['email'] as string,
    isAdmin: userRow['is_admin'] as boolean,
    apps: appAccesses.map((a) => ({ appId: a.appId, role: a.role })),
    clientId: input.clientId,
  });

  return {
    ok: true,
    result: {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: 15 * 60,
    },
  };
}

export { validateRedirectUri };
