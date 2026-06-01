/**
 * Admin API + GUI
 *
 * All routes under /admin require isAdmin: true in JWT (enforced by requireAdmin middleware).
 *
 * API endpoints (JSON):
 *   GET    /admin/api/users            — list all users with app access
 *   GET    /admin/api/users/:id        — user detail
 *   POST   /admin/api/users/:id/access — grant app access
 *   DELETE /admin/api/users/:id/access/:appId — revoke app access
 *   POST   /admin/api/invites          — create admin invite
 *   POST   /admin/api/users/:id/password-reset — create reset token
 *
 * GUI routes (HTML):
 *   GET    /admin                      — user list
 *   GET    /admin/users/:id            — user detail + access editor
 *   GET    /admin/invite               — invite generator
 *   GET    /admin/login                — login page (redirects to /authorize)
 */

import { Router, type IRouter, type Request } from 'express';
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
import { getAllApps } from '../../config/apps';

export const adminRouter: IRouter = Router();

/**
 * Whether to answer with rendered HTML rather than JSON. True for htmx requests
 * (which send the HX-Request header) and for browser navigations that explicitly
 * prefer HTML. API clients (and tests) send neither, so they keep getting JSON:
 * with no Accept header, req.accepts(['json','html']) returns the first listed,
 * 'json'.
 */
function wantsHtml(req: Request): boolean {
  return Boolean(req.get('HX-Request')) || req.accepts(['json', 'html']) === 'html';
}

// Login (/admin/login) and the GitHub OAuth callback (/admin/github/callback)
// are served by githubOauthRouter, which is mounted before this router in
// app.ts — so requests to them never reach the guard below.

// ── API — all require admin JWT ────────────────────────────────────────────

adminRouter.use('/admin/api', requireAdmin);
adminRouter.use('/admin', (req, res, next) => {
  // GUI routes: require admin cookie/header. The login and OAuth callback paths
  // are handled upstream; exempt them here too as a defensive measure.
  if (req.path === '/login' || req.path === '/github/callback') return next();
  return requireAdmin(req, res, next);
});

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

// POST /admin/api/users/:id/access
adminRouter.post('/admin/api/users/:id/access', async (req, res) => {
  const userId = req.params['id']!;
  const { appId, role } = req.body as Record<string, string>;
  if (!appId || !role) {
    res.status(400).json({ error: 'appId and role required' });
    return;
  }
  const access = await grantAccess(userId, appId, role);

  // The user-detail page grants access via htmx, swapping the whole #access-table
  // (hx-swap="outerHTML"). Render the updated table fragment; API clients get JSON.
  if (wantsHtml(req)) {
    const updated = await getAccessForUser(userId);
    res.render('admin/_access-table', { access: updated, user: { id: userId } });
    return;
  }
  res.status(201).json({ appId: access.appId, role: access.role });
});

// DELETE /admin/api/users/:id/access/:appId
adminRouter.delete('/admin/api/users/:id/access/:appId', async (req, res) => {
  await revokeAccess(req.params['id']!, req.params['appId']!);

  // htmx targets the row with hx-swap="outerHTML"; an empty 200 body removes it.
  // (A 204 would make htmx skip the swap, leaving the stale row in the DOM.)
  if (wantsHtml(req)) {
    res.send('');
    return;
  }
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

  // The admin invite form is a native (non-htmx) POST that navigates, so render
  // the page back with the generated token. API clients still get JSON.
  if (wantsHtml(req)) {
    res.render('admin/invite', { apps: getAllApps(), result: { token } });
    return;
  }

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

  // The user-detail page triggers this via htmx, swapping the link into
  // #reset-result (hx-swap="innerHTML"). Render the fragment; API clients get JSON.
  if (wantsHtml(req)) {
    res.render('admin/_reset-result', { token });
    return;
  }
  res.status(201).json({ token, link: `/reset-password?token=${token}` });
});

// ── GUI views ──────────────────────────────────────────────────────────────

// GET /admin — user list
adminRouter.get('/admin', async (_req, res) => {
  const { rows } = await getPool().query<Record<string, unknown>>(`
    SELECT u.id, u.email, u.username, u.is_admin, u.last_login_at,
           count(a.app_id) as app_count
    FROM homectl_auth.users u
    LEFT JOIN homectl_auth.app_access a ON a.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);
  const apps = getAllApps();
  res.render('admin/users', { users: rows, apps });
});

// GET /admin/users/:id
adminRouter.get('/admin/users/:id', async (req, res) => {
  const user = await findUserById(req.params['id']!);
  if (!user) {
    res.status(404).send('User not found');
    return;
  }
  const access = await getAccessForUser(user.id);
  const apps = getAllApps();
  res.render('admin/user-detail', { user, access, apps });
});

// GET /admin/invite
adminRouter.get('/admin/invite', (_req, res) => {
  const apps = getAllApps();
  res.render('admin/invite', { apps, result: null });
});
