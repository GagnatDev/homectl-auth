/**
 * Password Reset Module
 *
 * Admin-generated single-use reset links (24h TTL).
 * On redemption: updates password hash, invalidates ALL sessions for the user.
 * Outstanding access tokens remain valid until exp (up to 15 min) — documented limitation.
 */

import { randomBytes, createHash } from 'crypto';
import { getPool } from '../../db';
import { findUserById, updatePasswordHash } from '../user/user.repository';
import { hashPassword } from '../user/password.service';
import { deleteAllSessionsForUser } from '../session/session.service';

const RESET_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// ── Create reset token ─────────────────────────────────────────────────────

export type CreateResetTokenInput = { userId: string };
export type CreateResetTokenResult = { token: string };

export async function createResetToken(
  input: CreateResetTokenInput,
): Promise<CreateResetTokenResult> {
  const raw = randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  await getPool().query(
    `INSERT INTO homectl_auth.password_reset_tokens (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [tokenHash, input.userId, expiresAt],
  );

  return { token: raw };
}

// ── Redeem reset token ─────────────────────────────────────────────────────

export type RedeemResetInput = { token: string; newPassword: string };

export type RedeemResetError = 'INVALID_TOKEN' | 'EXPIRED_TOKEN' | 'ALREADY_USED' | 'USER_NOT_FOUND';

export type RedeemResetOutcome =
  | { ok: true; userId: string }
  | { ok: false; error: RedeemResetError };

export async function redeemReset(input: RedeemResetInput): Promise<RedeemResetOutcome> {
  const tokenHash = hashToken(input.token);

  const { rows } = await getPool().query<Record<string, unknown>>(
    'SELECT * FROM homectl_auth.password_reset_tokens WHERE token_hash = $1',
    [tokenHash],
  );

  const row = rows[0];
  if (!row) return { ok: false, error: 'INVALID_TOKEN' };

  const expiresAt = row['expires_at'] as Date;
  if (expiresAt < new Date()) {
    await getPool().query(
      'DELETE FROM homectl_auth.password_reset_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    return { ok: false, error: 'EXPIRED_TOKEN' };
  }

  const userId = row['user_id'] as string;

  // Atomic delete — single-use
  const { rowCount } = await getPool().query(
    'DELETE FROM homectl_auth.password_reset_tokens WHERE token_hash = $1',
    [tokenHash],
  );
  if (!rowCount || rowCount === 0) {
    return { ok: false, error: 'ALREADY_USED' };
  }

  const user = await findUserById(userId);
  if (!user) return { ok: false, error: 'USER_NOT_FOUND' };

  // Update password and invalidate all sessions
  const newHash = await hashPassword(input.newPassword);
  await updatePasswordHash(userId, newHash);
  await deleteAllSessionsForUser(userId);

  return { ok: true, userId };
}
