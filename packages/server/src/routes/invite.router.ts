/**
 * Invite endpoints.
 *
 * GET  /invite?token=…     — invite redemption page
 * POST /invite              — form submission (set username/password, activate account)
 * POST /api/invites         — delegated invite creation (Bearer JWT required)
 */

import { Router, type IRouter } from 'express';
import express from 'express';
import { redeemInvite, createDelegatedInvite } from '../modules/invite/invite.service';
import { verifyAccessToken } from '../modules/token/token.service';
import { getApp, getLandingUrl } from '../config/apps';
import { setSsoCookie } from '../modules/session/session.service';
import { serveShell } from '../web-shell';

export const inviteRouter: IRouter = Router();

/** Bounce back to the invite form with an error code the SPA maps to a message. */
function redirectToInviteError(res: import('express').Response, token: string, error: string): void {
  const q = new URLSearchParams({ token, error });
  res.redirect(302, `/invite?${q.toString()}`);
}

// ── GET /invite ────────────────────────────────────────────────────────────

inviteRouter.get('/invite', (req, res) => {
  const { token } = req.query as Record<string, string>;
  if (!token) {
    res.status(400).send('Missing invite token');
    return;
  }
  // The SPA invite page reads the token + error from the query string.
  serveShell(res);
});

// ── POST /invite ───────────────────────────────────────────────────────────

inviteRouter.post('/invite', express.urlencoded({ extended: false }), async (req, res) => {
  const { token, username, password } = req.body as Record<string, string>;

  if (!token || !username || !password) {
    redirectToInviteError(res, token ?? '', 'missing_fields');
    return;
  }

  if (password.length < 8) {
    redirectToInviteError(res, token, 'password_too_short');
    return;
  }

  const outcome = await redeemInvite({ token, username, password });

  if (!outcome.ok) {
    redirectToInviteError(res, token, outcome.error);
    return;
  }

  // Activation of a NEW account is a full authentication event — the redeemer
  // just chose the account's password — so establish SSO. The app they land on
  // then gets a code via the /authorize SSO short-circuit with no login form.
  // Existing accounts get no session: an invite token only proves possession
  // of the token (which the inviter also holds), not the account's
  // credentials, so it must never authenticate an already-established user.
  if (outcome.accountCreated) {
    setSsoCookie(res, outcome.userId);
  }

  // Post-signup destination is derived exclusively from server-side app config
  // (never from request input), so this cannot become an open redirect.
  const destinations = outcome.grantedAppIds.flatMap((appId) => {
    const app = getApp(appId);
    const url = app ? getLandingUrl(app) : null;
    return app && url ? [{ appId: app.id, url }] : [];
  });

  if (destinations.length === 1) {
    // Single app granted — send the user straight to it.
    res.redirect(302, destinations[0]!.url);
  } else if (destinations.length > 1) {
    // Multiple apps granted — let the confirmation page render a chooser.
    const q = new URLSearchParams({
      invited: '1',
      apps: destinations.map((d) => d.appId).join(','),
    });
    res.redirect(302, `/?${q.toString()}`);
  } else {
    // No navigable app (grant-less invite or apps without a landing URL).
    res.redirect(302, '/?invited=1');
  }
});

// ── POST /api/invites ──────────────────────────────────────────────────────

inviteRouter.post('/api/invites', async (req, res) => {
  // Validate Bearer JWT
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const token = authHeader.slice(7);

  let payload;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  const { email, appId, role } = req.body as Record<string, string>;
  if (!email || !appId || !role) {
    res.status(400).json({ error: 'invalid_request', error_description: 'email, appId, role required' });
    return;
  }

  const outcome = await createDelegatedInvite({
    email,
    appId,
    role,
    inviterUserId: payload.sub,
    inviterAppId: appId,
  });

  if (!outcome.ok) {
    const statusMap: Record<typeof outcome.error, number> = {
      NO_INVITER_ACCESS: 403,
      RANK_TOO_HIGH: 403,
      UNKNOWN_APP: 400,
      UNKNOWN_ROLE: 400,
    };
    res.status(statusMap[outcome.error]).json({ error: outcome.error });
    return;
  }

  res.status(201).json({ token: outcome.result.token });
});
