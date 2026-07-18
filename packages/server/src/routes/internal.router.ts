/**
 * Internal, server-to-server endpoints for in-cluster callers (e.g. an auth
 * sidecar). Client-authenticated with client_id + client_secret; they never
 * rely on a browser Origin or on cookies. Intended to be reached over the
 * in-cluster ClusterIP Service, not the public ingress.
 *
 * POST /internal/refresh
 *   Body: { client_id, client_secret, refresh_token }
 *   Rotates the opaque refresh token and returns a fresh access token PLUS the
 *   rotated refresh token in the JSON body (never as a Set-Cookie). The caller
 *   owns storage of the rotated refresh token. This is the machine-to-machine
 *   analogue of the browser-facing POST /refresh, which instead derives the
 *   client from the Origin header and reads/writes the refresh cookie.
 */

import { Router, type IRouter } from 'express';
import { verifyClientSecret } from '../modules/client/client.service';
import { rotateSession, deleteSessionByToken } from '../modules/session/session.service';
import { signAccessToken } from '../modules/token/token.service';
import { getAccessForUser } from '../modules/app-access/app-access.repository';
import { findUserById } from '../modules/user/user.repository';
import { recordRefresh } from '../modules/activity/activity.service';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const internalRouter: IRouter = Router();

internalRouter.post('/internal/refresh', async (req, res) => {
  const { client_id, client_secret, refresh_token } = req.body as Record<string, string>;

  if (!client_id || !client_secret || !refresh_token) {
    res
      .status(400)
      .json({ error: 'invalid_request', error_description: 'Missing required fields' });
    return;
  }

  // Authenticate the calling app (constant-time compare — same as /token exchange).
  const clientOk = await verifyClientSecret(client_id, client_secret);
  if (!clientOk) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }

  // Rotate the opaque refresh token: old token is invalidated, a new one issued.
  const rotated = await rotateSession(refresh_token, client_id);
  if (!rotated) {
    res.status(401).json({ error: 'invalid_refresh_token' });
    return;
  }

  const { newToken, userId } = rotated;

  const user = await findUserById(userId);
  if (!user) {
    await deleteSessionByToken(newToken, client_id);
    res.status(401).json({ error: 'user_not_found' });
    return;
  }

  const appAccesses = await getAccessForUser(userId);

  // Access may have been revoked since the session was created. Drop the just
  // rotated session so a revoked user cannot keep spinning fresh tokens.
  const hasAccess = appAccesses.some((a) => a.appId === client_id);
  if (!hasAccess) {
    await deleteSessionByToken(newToken, client_id);
    res.status(403).json({ error: 'access_revoked' });
    return;
  }

  const accessToken = await signAccessToken({
    sub: userId,
    email: user.email,
    isAdmin: user.isAdmin,
    apps: appAccesses.map((a) => ({ appId: a.appId, role: a.role })),
    clientId: client_id,
  });

  // Ongoing app usage for the admin statistics (coalesced; never throws)
  await recordRefresh(userId, client_id);

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: newToken,
    refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
  });
});
