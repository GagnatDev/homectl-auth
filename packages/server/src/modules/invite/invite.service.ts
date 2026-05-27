/**
 * Invite Module
 *
 * Two actor types:
 *  - Admin: bypasses all rank checks; can grant any role in any app.
 *  - Privileged app user: subject to rank enforcement (invitee.rank < inviter.rank).
 *
 * On redemption:
 *  - If email has no account → create user, grant access.
 *  - If email already has an account → add app access (password unchanged).
 *  - If the email now belongs to a DIFFERENT user than expected → reject (race).
 */

import { randomBytes, createHash } from 'crypto';
import { getPool } from '../../db';
import { createUser, findUserByEmail, updatePasswordHash } from '../user/user.repository';
import { hashPassword } from '../user/password.service';
import { grantAccess } from '../app-access/app-access.repository';
import { findAccess } from '../app-access/app-access.repository';
import { getApp, getRoleRank } from '../../config/apps';

const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type AppGrant = { appId: string; role: string };

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// ── Create invite ──────────────────────────────────────────────────────────

export type CreateAdminInviteInput = {
  email: string;
  appGrants: AppGrant[];
  createdByUserId: string;
};

export type CreateDelegatedInviteInput = {
  email: string;
  appId: string;
  role: string;
  inviterUserId: string;
  inviterAppId: string;
};

export type CreateInviteResult = { token: string };

export type CreateInviteError =
  | 'NO_INVITER_ACCESS'
  | 'RANK_TOO_HIGH'
  | 'UNKNOWN_APP'
  | 'UNKNOWN_ROLE';

export type CreateInviteOutcome =
  | { ok: true; result: CreateInviteResult }
  | { ok: false; error: CreateInviteError };

export async function createAdminInvite(
  input: CreateAdminInviteInput,
): Promise<CreateInviteResult> {
  const raw = randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  // Check if email already has an account — record expected_user_id for race detection
  const existing = await findUserByEmail(input.email);

  await getPool().query(
    `INSERT INTO homectl_auth.invite_tokens
       (token_hash, email, app_grants, expires_at, created_by_user_id, expected_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tokenHash,
      input.email,
      JSON.stringify(input.appGrants),
      expiresAt,
      input.createdByUserId,
      existing?.id ?? null,
    ],
  );

  return { token: raw };
}

export async function createDelegatedInvite(
  input: CreateDelegatedInviteInput,
): Promise<CreateInviteOutcome> {
  const app = getApp(input.appId);
  if (!app) {
    return { ok: false, error: 'UNKNOWN_APP' };
  }

  // Invitee role must be known to the app
  const inviteeRank = getRoleRank(app, input.role);
  if (inviteeRank < 0) {
    return { ok: false, error: 'UNKNOWN_ROLE' };
  }

  // Inviter must have access to the app
  const inviterAccess = await findAccess(input.inviterUserId, input.appId);
  if (!inviterAccess) {
    return { ok: false, error: 'NO_INVITER_ACCESS' };
  }

  // Rank enforcement: invitee.rank MUST be strictly less than inviter.rank
  const inviterRank = getRoleRank(app, inviterAccess.role);
  if (inviteeRank >= inviterRank) {
    return { ok: false, error: 'RANK_TOO_HIGH' };
  }

  const { token } = await createAdminInvite({
    email: input.email,
    appGrants: [{ appId: input.appId, role: input.role }],
    createdByUserId: input.inviterUserId,
  });

  // Patch in the created_by_app_id
  await getPool().query(
    `UPDATE homectl_auth.invite_tokens
     SET created_by_app_id = $1
     WHERE token_hash = $2`,
    [input.inviterAppId, hashToken(token)],
  );

  return { ok: true, result: { token } };
}

// ── Redeem invite ──────────────────────────────────────────────────────────

export type RedeemInviteInput = {
  token: string;
  username: string;
  password: string;
};

export type RedeemInviteError =
  | 'INVALID_TOKEN'
  | 'EXPIRED_TOKEN'
  | 'ALREADY_USED'
  | 'EMAIL_RACE';

export type RedeemInviteOutcome =
  | { ok: true; userId: string }
  | { ok: false; error: RedeemInviteError };

export async function redeemInvite(input: RedeemInviteInput): Promise<RedeemInviteOutcome> {
  const tokenHash = hashToken(input.token);

  // Fetch invite row (not deleted yet)
  const { rows } = await getPool().query<Record<string, unknown>>(
    'SELECT * FROM homectl_auth.invite_tokens WHERE token_hash = $1',
    [tokenHash],
  );

  const row = rows[0];
  if (!row) return { ok: false, error: 'INVALID_TOKEN' };

  const expiresAt = row['expires_at'] as Date;
  if (expiresAt < new Date()) {
    await getPool().query(
      'DELETE FROM homectl_auth.invite_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    return { ok: false, error: 'EXPIRED_TOKEN' };
  }

  const email = row['email'] as string;
  const appGrants = row['app_grants'] as AppGrant[];
  const expectedUserId = (row['expected_user_id'] as string | null) ?? null;

  // Atomic delete — if another request already consumed it, rowCount will be 0
  const { rowCount } = await getPool().query(
    'DELETE FROM homectl_auth.invite_tokens WHERE token_hash = $1',
    [tokenHash],
  );
  if (!rowCount || rowCount === 0) {
    return { ok: false, error: 'ALREADY_USED' };
  }

  // Check if an account with this email already exists
  const existingUser = await findUserByEmail(email);

  let userId: string;

  if (existingUser) {
    // Race check: if expected_user_id was set and doesn't match, reject
    if (expectedUserId && existingUser.id !== expectedUserId) {
      return { ok: false, error: 'EMAIL_RACE' };
    }
    // Add app access to existing account (password unchanged)
    userId = existingUser.id;
  } else {
    // Create new account
    const passwordHash = await hashPassword(input.password);
    const newUser = await createUser({
      email,
      username: input.username,
      passwordHash,
    });
    userId = newUser.id;
  }

  // Grant all app accesses from the invite
  for (const grant of appGrants) {
    await grantAccess(userId, grant.appId, grant.role);
  }

  return { ok: true, userId };
}
