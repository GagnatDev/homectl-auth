/**
 * Session endpoints — browser-facing, cross-origin with credentials.
 *
 * POST /refresh  — rotates the per-app refresh cookie, returns a new access token
 * POST /logout   — deletes the session for the calling app, clears the refresh cookie
 */

import { Router, type IRouter } from 'express';
import {
  rotateSession,
  deleteSessionByToken,
  setRefreshCookie,
  clearRefreshCookie,
  getRefreshTokenFromCookie,
  setSsoCookie,
  getSsoCookieValue,
} from '../modules/session/session.service';
import { signAccessToken } from '../modules/token/token.service';
import { getAccessForUser } from '../modules/app-access/app-access.repository';
import { findUserById } from '../modules/user/user.repository';
import { recordRefresh } from '../modules/activity/activity.service';
import { getAllApps } from '../config/apps';
import { credentialsCors } from '../middleware/cors.middleware';

export const sessionRouter: IRouter = Router();

// Apply CORS to both endpoints — the client_id is derived from the Origin header
sessionRouter.use('/refresh', credentialsCors);
sessionRouter.use('/logout', credentialsCors);

// ── POST /refresh ──────────────────────────────────────────────────────────

sessionRouter.post('/refresh', async (req, res) => {
  // Determine which app is calling based on Origin header.
  // The credentialsCors middleware already blocked non-allow-listed origins,
  // so by the time we get here Origin is either absent (same-origin / no-CORS)
  // or present and valid.
  const origin = req.headers['origin'] as string | undefined;
  const clientId = resolveClientIdFromOrigin(origin);

  if (!clientId) {
    res.status(400).json({ error: 'unknown_origin' });
    return;
  }

  const rawToken = getRefreshTokenFromCookie(req.cookies as Record<string, string>, clientId);
  if (!rawToken) {
    res.status(401).json({ error: 'missing_refresh_token' });
    return;
  }

  const rotated = await rotateSession(rawToken, clientId);
  if (!rotated) {
    clearRefreshCookie(res, clientId);
    res.status(401).json({ error: 'invalid_refresh_token' });
    return;
  }

  const { newToken, userId } = rotated;

  // Set new refresh cookie
  setRefreshCookie(res, clientId, newToken);

  // Mint new access token
  const user = await findUserById(userId);
  if (!user) {
    res.status(401).json({ error: 'user_not_found' });
    return;
  }

  const appAccesses = await getAccessForUser(userId);

  // Check the user still has access to this specific app
  const hasAccess = appAccesses.some((a) => a.appId === clientId);
  if (!hasAccess) {
    clearRefreshCookie(res, clientId);
    res.status(403).json({ error: 'access_revoked' });
    return;
  }

  const accessToken = await signAccessToken({
    sub: userId,
    email: user.email,
    isAdmin: user.isAdmin,
    apps: appAccesses.map((a) => ({ appId: a.appId, role: a.role })),
    clientId,
  });

  // Ongoing app usage for the admin statistics (coalesced; never throws)
  await recordRefresh(userId, clientId);

  res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 900 });
});

// ── POST /logout ───────────────────────────────────────────────────────────

sessionRouter.post('/logout', async (req, res) => {
  const origin = req.headers['origin'] as string | undefined;
  const clientId = resolveClientIdFromOrigin(origin);

  // Logout is best-effort — if we can't identify the app from Origin (no CORS
  // context), still clear whatever cookies we can and return 204.
  if (!clientId) {
    res.status(204).end();
    return;
  }

  const rawToken = getRefreshTokenFromCookie(req.cookies as Record<string, string>, clientId);
  if (rawToken) {
    await deleteSessionByToken(rawToken, clientId);
    clearRefreshCookie(res, clientId);
  }

  // homectl_sso cookie is intentionally preserved — see PRD §Session Module
  res.status(204).end();
});

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveClientIdFromOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  for (const app of getAllApps()) {
    if (app.allowedOrigins.includes(origin)) {
      return app.id;
    }
  }
  return null;
}
