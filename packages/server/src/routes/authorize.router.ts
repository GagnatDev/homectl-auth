/**
 * Authorization Code Flow — browser-facing endpoints.
 *
 * GET  /authorize  — renders login form (or redirects immediately via SSO cookie)
 * POST /login      — credential submission; on success redirects to redirect_uri
 */

import { Router, type IRouter } from 'express';
import { getApp, getLandingUrl, validateRedirectUri } from '../config/apps';
import { verifyPassword } from '../modules/user/password.service';
import { issueCode } from '../modules/auth-code/auth-code.service';
import { hasAccess } from '../modules/app-access/app-access.repository';
import {
  createSession,
  setRefreshCookie,
  setSsoCookie,
  getSsoCookieValue,
} from '../modules/session/session.service';
import { findUserById, updateLastLogin } from '../modules/user/user.repository';
import { recordLogin } from '../modules/activity/activity.service';
import { serveShell } from '../web-shell';
import express from 'express';

export const authorizeRouter: IRouter = Router();

/**
 * Send the user back to the login page with an error code. The login form lives
 * in the SPA, which reads `error` from the query string. We re-attach the OAuth
 * params so the re-rendered form can post again.
 */
function redirectToLoginError(
  res: import('express').Response,
  params: { clientId: string; redirectUri: string; state: string; error: string },
): void {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    error: params.error,
  });
  if (params.state) q.set('state', params.state);
  res.redirect(302, `/authorize?${q.toString()}`);
}

// ── GET /api/apps/:clientId ──────────────────────────────────────────────────
// Public: the SPA login page fetches the app's display name for its heading,
// and the post-invite confirmation page fetches name + landing URL for the
// app chooser. Exposes only id, name, and the user-facing landing URL —
// never the client secret env or redirect URIs.

authorizeRouter.get('/api/apps/:clientId', (req, res) => {
  const app = getApp(req.params['clientId']!);
  if (!app) {
    res.status(404).json({ error: 'unknown_client' });
    return;
  }
  res.json({ id: app.id, name: app.name, landingUrl: getLandingUrl(app) });
});

// ── GET /authorize ─────────────────────────────────────────────────────────

authorizeRouter.get('/authorize', async (req, res) => {
  const { client_id, redirect_uri, state, response_type } = req.query as Record<string, string>;

  if (response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type' });
    return;
  }

  const app = getApp(client_id);
  if (!app) {
    res.status(400).json({ error: 'unknown_client' });
    return;
  }

  if (!redirect_uri || !validateRedirectUri(app, redirect_uri)) {
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  // SSO short-circuit: if the user already has a valid sso cookie and access to this app,
  // skip the login form and redirect directly with a new authorization code.
  const ssoCookieUserId = getSsoCookieValue(req.cookies as Record<string, string>);
  if (ssoCookieUserId) {
    const allowed = await hasAccess(ssoCookieUserId, client_id);
    if (allowed) {
      const user = await findUserById(ssoCookieUserId);
      if (user) {
        const rawToken = await createSession(ssoCookieUserId, client_id);
        setRefreshCookie(res, client_id, rawToken);

        // An SSO short-circuit is a sign-in to this app: stamp last_login_at
        // and record it for the admin statistics.
        await updateLastLogin(ssoCookieUserId);
        await recordLogin(ssoCookieUserId, client_id, 'sso_login');

        const { code } = await issueCode({
          userId: ssoCookieUserId,
          clientId: client_id,
          redirectUri: redirect_uri,
        });

        const callbackUrl = new URL(redirect_uri);
        callbackUrl.searchParams.set('code', code);
        if (state) callbackUrl.searchParams.set('state', state);
        res.redirect(302, callbackUrl.toString());
        return;
      }
    }
  }

  // Render the SPA shell; the React login page reads client_id / redirect_uri /
  // state / error from the query string and the app name from /api/apps/:id.
  serveShell(res);
});

// ── POST /login ────────────────────────────────────────────────────────────

authorizeRouter.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  const { client_id, redirect_uri, state, username, password } = req.body as Record<
    string,
    string
  >;

  const app = getApp(client_id);
  if (!app) {
    res.status(400).json({ error: 'unknown_client' });
    return;
  }

  if (!redirect_uri || !validateRedirectUri(app, redirect_uri)) {
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  // Find user by username (we look them up via email column — support both for
  // login; the login form sends "username" which maps to the username field)
  // Try username first, then fall back to treating input as email
  const { rows: userRows } = await (async () => {
    const pool = (await import('../db')).getPool();
    return pool.query<Record<string, unknown>>(
      `SELECT * FROM homectl_auth.users
       WHERE username = $1 OR email = $1`,
      [username],
    );
  })();

  const loginErrorParams = { clientId: client_id, redirectUri: redirect_uri, state: state ?? '' };

  if (!userRows[0]) {
    redirectToLoginError(res, { ...loginErrorParams, error: 'invalid_credentials' });
    return;
  }

  const user = userRows[0];
  const valid = await verifyPassword(password, user['password_hash'] as string);
  if (!valid) {
    redirectToLoginError(res, { ...loginErrorParams, error: 'invalid_credentials' });
    return;
  }

  const userId = user['id'] as string;

  // Check app access
  const allowed = await hasAccess(userId, client_id);
  if (!allowed) {
    redirectToLoginError(res, { ...loginErrorParams, error: 'no_access' });
    return;
  }

  // Stamp last_login_at and record the login for the admin statistics
  await updateLastLogin(userId);
  await recordLogin(userId, client_id, 'login');

  // Issue authorization code
  const { code } = await issueCode({ userId, clientId: client_id, redirectUri: redirect_uri });

  // Create session — sets per-app refresh cookie
  const rawToken = await createSession(userId, client_id);
  setRefreshCookie(res, client_id, rawToken);

  // Set SSO cookie if not already set
  const existingSso = getSsoCookieValue(req.cookies as Record<string, string>);
  if (!existingSso) {
    setSsoCookie(res, userId);
  }

  // Redirect to callback
  const callbackUrl = new URL(redirect_uri);
  callbackUrl.searchParams.set('code', code);
  if (state) callbackUrl.searchParams.set('state', state);

  res.redirect(302, callbackUrl.toString());
});
