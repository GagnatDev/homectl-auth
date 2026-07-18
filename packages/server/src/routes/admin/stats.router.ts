/**
 * Admin statistics API — aggregates over homectl_auth.activity_events (and
 * live sessions) for the admin console dashboard.
 *
 *   GET /admin/api/stats/overview        — headline counts + live sessions per app
 *   GET /admin/api/stats/activity?days=N — daily logins + active users, zero-filled
 *   GET /admin/api/stats/apps?days=N     — per-app usage within the window
 *
 * Mounted under /admin/api in admin.router.ts, so requireAdmin already guards
 * every route here.
 */

import { Router, type IRouter } from 'express';
import { getAllApps } from '../../config/apps';
import {
  getOverviewCounts,
  getActiveSessionCounts,
  getDailyActivity,
  getAppActivity,
  getGrantedUserCounts,
} from '../../modules/activity/activity.repository';

export const statsRouter: IRouter = Router();

/** Parse a ?days= query param, clamped to 1–365. */
export function parseDays(raw: unknown, fallback = 30): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(365, Math.max(1, parsed));
}

function appName(clientId: string): string {
  return getAllApps().find((a) => a.id === clientId)?.name ?? clientId;
}

// GET /admin/api/stats/overview
statsRouter.get('/overview', async (_req, res) => {
  const [counts, sessions] = await Promise.all([
    getOverviewCounts(),
    getActiveSessionCounts(),
  ]);

  res.json({
    totalUsers: counts.totalUsers,
    neverLoggedIn: counts.neverLoggedIn,
    newUsers30d: counts.newUsers30d,
    activeUsers: {
      day: counts.activeUsers1d,
      week: counts.activeUsers7d,
      month: counts.activeUsers30d,
    },
    activeSessions: sessions.map((s) => ({
      clientId: s.clientId,
      name: appName(s.clientId),
      sessions: s.sessions,
      users: s.users,
    })),
    totalActiveSessions: sessions.reduce((sum, s) => sum + s.sessions, 0),
  });
});

// GET /admin/api/stats/activity?days=30
statsRouter.get('/activity', async (req, res) => {
  const days = parseDays(req.query['days']);
  const series = await getDailyActivity(days);
  res.json({ days, series });
});

// GET /admin/api/stats/apps?days=30
statsRouter.get('/apps', async (req, res) => {
  const days = parseDays(req.query['days']);
  const [activity, granted] = await Promise.all([getAppActivity(days), getGrantedUserCounts()]);
  const byClientId = new Map(activity.map((a) => [a.clientId, a]));

  // Configured apps first (including ones with zero activity), then any app
  // that has events but has since been removed from the config.
  const configured = getAllApps().map((app) => {
    const a = byClientId.get(app.id);
    byClientId.delete(app.id);
    return {
      clientId: app.id,
      name: app.name,
      configured: true,
      grantedUsers: granted.get(app.id) ?? 0,
      logins: a?.logins ?? 0,
      activeUsers: a?.activeUsers ?? 0,
      lastUsedAt: a?.lastUsedAt ?? null,
    };
  });
  const removed = Array.from(byClientId.values()).map((a) => ({
    clientId: a.clientId,
    name: a.clientId,
    configured: false,
    grantedUsers: granted.get(a.clientId) ?? 0,
    logins: a.logins,
    activeUsers: a.activeUsers,
    lastUsedAt: a.lastUsedAt,
  }));

  res.json({ days, apps: [...configured, ...removed] });
});
