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

  // Redirect to login with a success message (simple — no flash messages in v1)
  res.redirect(302, '/?invited=1');
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
