/**
 * Admin JSON API
 *
 * All routes under /admin/api require isAdmin: true in JWT (enforced by the
 * requireAdmin middleware). The admin GUI is a React SPA (packages/web) served
 * as the static shell on the /admin* page routes; it consumes these endpoints.
 *
 *   GET    /admin/api/users            — list all users with app access
 *   GET    /admin/api/users/:id        — user detail
 *   GET    /admin/api/users/:id/activity — per-user activity statistics
 *   GET    /admin/api/apps             — configured apps + roles (for dropdowns)
 *   POST   /admin/api/users/:id/access — grant app access
 *   DELETE /admin/api/users/:id/access/:appId — revoke app access
 *   POST   /admin/api/invites          — create admin invite
 *   POST   /admin/api/users/:id/password-reset — create reset token
 *   GET    /admin/api/stats/*          — dashboard statistics (stats.router.ts)
 */

import { Router, type IRouter } from 'express';
import { requireAdmin } from '../../middleware/require-admin';
import { getPool } from '../../db';
import { findUserById } from '../../modules/user/user.repository';
import {
  grantAccess,
  revokeAccess,
  getAccessForUser,
} from '../../modules/app-access/app-access.repository';
import { createAdminInvite } from '../../modules/invite/invite.service';
import { createResetToken } from '../../modules/password-reset/password-reset.service';
import {
  getUserAppActivity,
  getRecentUserEvents,
} from '../../modules/activity/activity.repository';
import { getAllApps } from '../../config/apps';
import { statsRouter, parseDays } from './stats.router';

export const adminRouter: IRouter = Router();

// ── API — all require admin JWT ────────────────────────────────────────────
// The GUI page routes (/admin, /admin/users/:id, /admin/invite, /admin/login)
// are not guarded here: they only serve the static SPA shell (no data), so they
// fall through to the shell catch-all in app.ts. Auth is enforced when the SPA
// calls these /admin/api endpoints; a 401/403 sends the SPA to /admin/login.

adminRouter.use('/admin/api', requireAdmin);
adminRouter.use('/admin/api/stats', statsRouter);

// GET /admin/api/users
adminRouter.get('/admin/api/users', async (_req, res) => {
  const { rows } = await getPool().query<Record<string, unknown>>(`
    SELECT u.id, u.email, u.username, u.is_admin, u.created_at, u.last_login_at,
           json_agg(
             json_build_object('appId', a.app_id, 'role', a.role)
             ORDER BY a.app_id
           ) FILTER (WHERE a.app_id IS NOT NULL) AS app_access
    FROM homectl_auth.users u
    LEFT JOIN homectl_auth.app_access a ON a.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);

  res.json(
    rows.map((r) => ({
      id: r['id'],
      email: r['email'],
      username: r['username'],
      isAdmin: r['is_admin'],
      createdAt: r['created_at'],
      lastLoginAt: r['last_login_at'],
      appAccess: r['app_access'] ?? [],
    })),
  );
});

// GET /admin/api/users/:id
adminRouter.get('/admin/api/users/:id', async (req, res) => {
  const user = await findUserById(req.params['id']!);
  if (!user) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const access = await getAccessForUser(user.id);
  res.json({
    id: user.id,
    email: user.email,
    username: user.username,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    appAccess: access.map((a) => ({ appId: a.appId, role: a.role })),
  });
});

// GET /admin/api/users/:id/activity?days=30 — per-app usage + recent events
adminRouter.get('/admin/api/users/:id/activity', async (req, res) => {
  const user = await findUserById(req.params['id']!);
  if (!user) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const days = parseDays(req.query['days']);
  const appNames = new Map(getAllApps().map((a) => [a.id, a.name]));
  const [apps, recent] = await Promise.all([
    getUserAppActivity(user.id, days),
    getRecentUserEvents(user.id, 20),
  ]);

  res.json({
    days,
    apps: apps.map((a) => ({
      clientId: a.clientId,
      name: appNames.get(a.clientId) ?? a.clientId,
      logins: a.logins,
      activeDays: a.activeDays,
      lastUsedAt: a.lastUsedAt,
    })),
    recent: recent.map((e) => ({
      clientId: e.clientId,
      name: appNames.get(e.clientId) ?? e.clientId,
      eventType: e.eventType,
      occurredAt: e.occurredAt,
    })),
  });
});

// POST /admin/api/users/:id/access
adminRouter.post('/admin/api/users/:id/access', async (req, res) => {
  const userId = req.params['id']!;
  const { appId, role } = req.body as Record<string, string>;
  if (!appId || !role) {
    res.status(400).json({ error: 'appId and role required' });
    return;
  }
  const access = await grantAccess(userId, appId, role);
  res.status(201).json({ appId: access.appId, role: access.role });
});

// DELETE /admin/api/users/:id/access/:appId
adminRouter.delete('/admin/api/users/:id/access/:appId', async (req, res) => {
  await revokeAccess(req.params['id']!, req.params['appId']!);
  res.status(204).end();
});

// POST /admin/api/invites
adminRouter.post('/admin/api/invites', async (req, res) => {
  const admin = res.locals['admin'];
  const { email, appGrants } = req.body as { email: string; appGrants: Array<{ appId: string; role: string }> };

  if (!email || !Array.isArray(appGrants)) {
    res.status(400).json({ error: 'email and appGrants required' });
    return;
  }

  const { token } = await createAdminInvite({
    email,
    appGrants,
    createdByUserId: admin.sub,
  });

  res.status(201).json({ token, link: `/invite?token=${token}` });
});

// POST /admin/api/users/:id/password-reset
adminRouter.post('/admin/api/users/:id/password-reset', async (req, res) => {
  const user = await findUserById(req.params['id']!);
  if (!user) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const { token } = await createResetToken({ userId: user.id });
  res.status(201).json({ token, link: `/reset-password?token=${token}` });
});

// GET /admin/api/apps — configured apps + roles, for the grant/invite dropdowns.
// Exposes only id, name, and roles — not client secret envs or redirect URIs.
adminRouter.get('/admin/api/apps', (_req, res) => {
  res.json(
    getAllApps().map((a) => ({
      id: a.id,
      name: a.name,
      roles: a.roles.map((r) => ({ name: r.name, rank: r.rank })),
    })),
  );
});
