/**
 * Authorization Code Flow — browser-facing endpoints.
 *
 * GET  /authorize  — renders login form (or redirects immediately via SSO cookie)
 * POST /login      — credential submission; on success redirects to redirect_uri
 */

import { Router, type IRouter } from 'express';
import { join } from 'path';
import { getApp, validateRedirectUri } from '../config/apps';
import { findUserByEmail } from '../modules/user/user.repository';
import { verifyPassword } from '../modules/user/password.service';
import { issueCode } from '../modules/auth-code/auth-code.service';
import { hasAccess } from '../modules/app-access/app-access.repository';
import express from 'express';

export const authorizeRouter: IRouter = Router();

// Serve EJS templates from src/views
const VIEWS_DIR = join(__dirname, '..', 'views');

// ── GET /authorize ─────────────────────────────────────────────────────────

authorizeRouter.get('/authorize', (req, res) => {
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

  res.render('login', {
    appName: app.name,
    clientId: client_id,
    redirectUri: redirect_uri,
    state: state ?? '',
    error: undefined,
  });
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

  const renderError = (error: string) => {
    res.status(401).render('login', {
      appName: app.name,
      clientId: client_id,
      redirectUri: redirect_uri,
      state: state ?? '',
      error,
    });
  };

  if (!userRows[0]) {
    renderError('Invalid username or password.');
    return;
  }

  const user = userRows[0];
  const valid = await verifyPassword(password, user['password_hash'] as string);
  if (!valid) {
    renderError('Invalid username or password.');
    return;
  }

  const userId = user['id'] as string;

  // Check app access
  const allowed = await hasAccess(userId, client_id);
  if (!allowed) {
    res.status(403).render('login', {
      appName: app.name,
      clientId: client_id,
      redirectUri: redirect_uri,
      state: state ?? '',
      error: 'You do not have access to this application.',
    });
    return;
  }

  // Issue authorization code
  const { code } = await issueCode({ userId, clientId: client_id, redirectUri: redirect_uri });

  // Redirect to callback
  const callbackUrl = new URL(redirect_uri);
  callbackUrl.searchParams.set('code', code);
  if (state) callbackUrl.searchParams.set('state', state);

  res.redirect(302, callbackUrl.toString());
});
