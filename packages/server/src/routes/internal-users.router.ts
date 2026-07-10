/**
 * Internal, server-to-server user import — for migrating an existing app onto
 * homectl-auth.
 *
 * POST /internal/users/import
 *   Body: { client_id, client_secret, users: [{ email, username,
 *           passwordHash, role? }] }
 *
 * A migrating app calls this once, up front, to seed its existing users into
 * homectl-auth so they keep their credentials. The app sends the *already
 * hashed* password (bcrypt, cost 12 — the same scheme homectl-auth uses, so the
 * hash is stored verbatim and users can log in with their current password with
 * no reset needed). Plaintext passwords are never sent.
 *
 * Imported users are always created NON-admin. homectl-auth's `isAdmin` flag
 * grants operator access to the domain-wide admin GUI (manage every user, all
 * app access, invites, resets) — it is not an app-scoped role, so a consuming
 * app must not be able to set it. An app's own "admin" concept belongs in the
 * per-app `role` grant (e.g. role: "admin"), which is scoped to that app only.
 *
 * Same trust model as POST /internal/refresh: authenticated with the app's
 * client_id + client_secret (constant-time compared), no browser Origin, no
 * cookies. Intended to be reached over the in-cluster ClusterIP Service
 * (`homectl-auth.homectl.svc.cluster.local`), not the public ingress.
 *
 * The import is idempotent and best-effort per user:
 *   - A new email → the user is created and granted access to the calling app.
 *   - An email that already exists in homectl-auth → the existing account is
 *     left untouched (password/isAdmin are NOT overwritten) but is granted
 *     access to the calling app. This is the shared-account SSO model: one user,
 *     one credential, access to many apps.
 *   - A per-user validation error (missing field, non-bcrypt hash, unknown role)
 *     is reported for that entry without failing the rest of the batch.
 *
 * Email is the sole identity key: users are matched and de-duplicated on email,
 * and it is the only UNIQUE column on the users table. Username is a display
 * handle and may collide freely across accounts.
 *
 * The response is always 200 (once the client is authenticated) with a
 * per-entry result array plus a summary, so the caller can retry safely and
 * reconcile.
 */

import { Router, type IRouter } from 'express';
import { verifyClientSecret } from '../modules/client/client.service';
import { getApp } from '../config/apps';
import { createUser, findUserByEmail } from '../modules/user/user.repository';
import { grantAccess } from '../modules/app-access/app-access.repository';

export const internalUsersRouter: IRouter = Router();

/**
 * bcryptjs output: `$2a$` / `$2b$` / `$2y$`, a two-digit cost, then a 22-char
 * base64 salt + 31-char base64 hash (53 chars total). Validated so a plaintext
 * password can never be stored as-is by mistake.
 */
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** Postgres unique-violation error code. */
const PG_UNIQUE_VIOLATION = '23505';

type ImportUserInput = {
  email?: unknown;
  username?: unknown;
  passwordHash?: unknown;
  role?: unknown;
};

type ImportStatus = 'created' | 'skipped' | 'invalid';

type ImportResult = {
  index: number;
  email: string | null;
  username: string | null;
  status: ImportStatus;
  userId?: string;
  role?: string;
  granted?: boolean;
  error?: string;
};

/** Lowest-rank (least privileged) role name for an app, or null if it has none. */
function defaultRoleFor(appId: string): string | null {
  const app = getApp(appId);
  if (!app || app.roles.length === 0) return null;
  return [...app.roles].sort((a, b) => a.rank - b.rank)[0]!.name;
}

internalUsersRouter.post('/internal/users/import', async (req, res) => {
  const { client_id, client_secret, users } = req.body as {
    client_id?: string;
    client_secret?: string;
    users?: unknown;
  };

  if (!client_id || !client_secret || users === undefined) {
    res
      .status(400)
      .json({ error: 'invalid_request', error_description: 'Missing required fields' });
    return;
  }

  if (!Array.isArray(users)) {
    res
      .status(400)
      .json({ error: 'invalid_request', error_description: 'users must be an array' });
    return;
  }

  // Authenticate the calling app (constant-time compare — same as /token exchange).
  const clientOk = await verifyClientSecret(client_id, client_secret);
  if (!clientOk) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }

  const app = getApp(client_id);
  const validRoles = new Set(app?.roles.map((r) => r.name) ?? []);
  const fallbackRole = defaultRoleFor(client_id);

  const results: ImportResult[] = [];

  for (let index = 0; index < users.length; index++) {
    const entry = (users[index] ?? {}) as ImportUserInput;
    const email = typeof entry.email === 'string' ? entry.email.trim() : null;
    const username = typeof entry.username === 'string' ? entry.username.trim() : null;
    const passwordHash = typeof entry.passwordHash === 'string' ? entry.passwordHash : null;

    const invalid = (error: string): void => {
      results.push({ index, email, username, status: 'invalid', error });
    };

    if (!email || !username || !passwordHash) {
      invalid('email, username, and passwordHash are required');
      continue;
    }

    if (!BCRYPT_HASH_RE.test(passwordHash)) {
      invalid('passwordHash must be a bcrypt hash (bcryptjs, cost 12)');
      continue;
    }

    // Resolve the role for the app-access grant. An explicit role must be one
    // the app declares; when omitted we fall back to the app's lowest-rank role.
    let role: string | null;
    if (entry.role !== undefined) {
      if (typeof entry.role !== 'string' || !validRoles.has(entry.role)) {
        invalid(`unknown role for app ${client_id}: ${String(entry.role)}`);
        continue;
      }
      role = entry.role;
    } else {
      role = fallbackRole;
    }

    // Idempotent path: an account with this email already exists. Never
    // overwrite its credentials or admin flag — just ensure it can reach the
    // migrating app (the one-account-many-apps SSO model).
    const existing = await findUserByEmail(email);
    if (existing) {
      let granted = false;
      if (role) {
        await grantAccess(existing.id, client_id, role);
        granted = true;
      }
      results.push({
        index,
        email,
        username,
        status: 'skipped',
        userId: existing.id,
        ...(role ? { role } : {}),
        granted,
        error: 'a user with this email already exists',
      });
      continue;
    }

    let userId: string;
    try {
      // Always non-admin: isAdmin is an operator-level, service-wide flag that a
      // consuming app must not be able to set. It falls back to the DB default.
      const user = await createUser({ email, username, passwordHash });
      userId = user.id;
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        const existing = await findUserByEmail(email);
        let granted = false;
        if (existing && role) {
          await grantAccess(existing.id, client_id, role);
          granted = true;
        }
        results.push({
          index,
          email,
          username,
          status: 'skipped',
          ...(existing ? { userId: existing.id } : {}),
          ...(role ? { role } : {}),
          granted,
          error: 'a user with this email already exists',
        });
        continue;
      }
      throw err;
    }

    let granted = false;
    if (role) {
      await grantAccess(userId, client_id, role);
      granted = true;
    }

    results.push({
      index,
      email,
      username,
      status: 'created',
      userId,
      ...(role ? { role } : {}),
      granted,
    });
  }

  const summary = {
    total: results.length,
    created: results.filter((r) => r.status === 'created').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    invalid: results.filter((r) => r.status === 'invalid').length,
    granted: results.filter((r) => r.granted).length,
  };

  res.status(200).json({ summary, results });
});
