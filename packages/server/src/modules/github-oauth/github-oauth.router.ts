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
 * Admin token cookie can stay SameSite=Strict — it is only used on same-site
 * navigation within the admin panel after login.
 */
function setAdminTokenCookie(res: Response, token: string): void {
  res.cookie(ADMIN_TOKEN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'strict',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });
}

// ── GET /admin/login ─────────────────────────────────────────────────────────

githubOauthRouter.get('/admin/login', (_req, res) => {
  const state = randomBytes(32).toString('hex');
  setStateCookie(res, state);
  res.render('admin/login', { authorizeUrl: buildAuthorizeUrl(state) });
});

// ── GET /admin/github/callback ─────────────────────────────────────────────────

githubOauthRouter.get('/admin/github/callback', async (req, res) => {
  const code = req.query['code'];
  const state = req.query['state'];
  const expectedState = (req.cookies as Record<string, string>)[STATE_COOKIE_NAME];

  clearStateCookie(res);

  // CSRF: the state echoed back by GitHub must match the cookie we set.
  if (
    typeof state !== 'string' ||
    typeof code !== 'string' ||
    !expectedState ||
    state !== expectedState
  ) {
    res.status(400).render('admin/error', { message: 'Invalid login state. Please try again.' });
    return;
  }

  try {
    const accessToken = await exchangeCode(code);
    const user = await getUser(accessToken);

    if (!isAllowed(user.id)) {
      logger.warn({ githubUserId: user.id, login: user.login }, 'admin login denied: not in allowlist');
      res.status(403).render('admin/error', { message: 'This GitHub account is not authorized for admin access.' });
      return;
    }

    const email = (await getPrimaryEmail(accessToken)) ?? `${user.login}@users.noreply.github.com`;
    const token = await signAdminToken({ githubUserId: user.id, login: user.login, email });

    setAdminTokenCookie(res, token);
    logger.info({ githubUserId: user.id, login: user.login }, 'admin login succeeded');
    res.redirect(302, '/admin');
  } catch (err) {
    logger.error({ err }, 'admin GitHub OAuth callback failed');
    res.status(502).render('admin/error', { message: 'GitHub login failed. Please try again.' });
  }
});
