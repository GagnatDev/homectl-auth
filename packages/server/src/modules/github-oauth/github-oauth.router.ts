/**
 * GitHub OAuth admin login routes.
 *
 *   GET /admin/login           — renders the "Login with GitHub" page and sets a
 *                                short-lived state cookie (CSRF protection).
 *   GET /admin/github/callback — handles the redirect back from GitHub: verifies
 *                                state, exchanges the code, checks the allowlist,
 *                                issues an 8h admin JWT into homectl_admin_token,
 *                                and redirects to /admin.
 *
 * The admin is not a local user — see github-oauth.service.ts.
 */

import { Router, type IRouter, type Response } from 'express';
import { randomBytes } from 'crypto';
import { logger } from '../../logger';
import {
  buildAuthorizeUrl,
  exchangeCode,
  getUser,
  getPrimaryEmail,
  isAllowed,
} from './github-oauth.service';
import { signAdminToken } from '../token/token.service';
import { serveShell } from '../../web-shell';

export const githubOauthRouter: IRouter = Router();

const STATE_COOKIE_NAME = 'homectl_admin_oauth_state';
const ADMIN_TOKEN_COOKIE_NAME = 'homectl_admin_token';

const isProd = (): boolean => process.env['NODE_ENV'] === 'production';

/**
 * State cookie MUST be SameSite=Lax: the callback is reached via a cross-site
 * top-level navigation from github.com, and a Strict cookie would not be sent.
 */
function setStateCookie(res: Response, state: string): void {
  res.cookie(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'lax',
    path: '/admin',
    maxAge: 10 * 60 * 1000, // 10 minutes
  });
}

function clearStateCookie(res: Response): void {
  res.clearCookie(STATE_COOKIE_NAME, { path: '/admin' });
}

/**
 * Admin token cookie MUST be SameSite=Lax: it is set in the callback response
 * which then redirects to /admin. That redirect is the hop immediately following
 * the cross-site navigation from github.com, so a Strict cookie would not be sent
 * on it and /admin would bounce straight back to /admin/login. Lax still blocks
 * the cookie on cross-site subrequests, and it remains httpOnly.
 */
function setAdminTokenCookie(res: Response, token: string): void {
  res.cookie(ADMIN_TOKEN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'lax',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });
}

// ── GET /admin/login ─────────────────────────────────────────────────────────
// Serves the SPA shell. The "Sign in with GitHub" button gets its URL (and the
// CSRF state cookie) from GET /api/admin-login below.

githubOauthRouter.get('/admin/login', (_req, res) => {
  serveShell(res);
});

// ── GET /api/admin-login ───────────────────────────────────────────────────────
// Public JSON: mints a fresh CSRF state, sets the state cookie, and returns the
// GitHub authorize URL for the SPA login page to link to.

githubOauthRouter.get('/api/admin-login', (_req, res) => {
  const state = randomBytes(32).toString('hex');
  setStateCookie(res, state);
  res.json({ url: buildAuthorizeUrl(state) });
});

// ── GET /admin/github/callback ─────────────────────────────────────────────────

githubOauthRouter.get('/admin/github/callback', async (req, res) => {
  const code = req.query['code'];
  const state = req.query['state'];
  const expectedState = (req.cookies as Record<string, string>)[STATE_COOKIE_NAME];

  clearStateCookie(res);

  // CSRF: the state echoed back by GitHub must match the cookie we set. On any
  // failure we bounce back to the SPA login page with an error code it renders.
  if (
    typeof state !== 'string' ||
    typeof code !== 'string' ||
    !expectedState ||
    state !== expectedState
  ) {
    res.redirect(302, '/admin/login?error=invalid_state');
    return;
  }

  try {
    const accessToken = await exchangeCode(code);
    const user = await getUser(accessToken);

    if (!isAllowed(user.id)) {
      logger.warn({ githubUserId: user.id, login: user.login }, 'admin login denied: not in allowlist');
      res.redirect(302, '/admin/login?error=not_authorized');
      return;
    }

    const email = (await getPrimaryEmail(accessToken)) ?? `${user.login}@users.noreply.github.com`;
    const token = await signAdminToken({ githubUserId: user.id, login: user.login, email });

    setAdminTokenCookie(res, token);
    logger.info({ githubUserId: user.id, login: user.login }, 'admin login succeeded');
    res.redirect(302, '/admin');
  } catch (err) {
    logger.error({ err }, 'admin GitHub OAuth callback failed');
    res.redirect(302, '/admin/login?error=github_failed');
  }
});
