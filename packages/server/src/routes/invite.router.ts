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
import { findAccess } from '../modules/app-access/app-access.repository';

export const inviteRouter: IRouter = Router();

// ── GET /invite ────────────────────────────────────────────────────────────

inviteRouter.get('/invite', (req, res) => {
  const { token } = req.query as Record<string, string>;
  if (!token) {
    res.status(400).send('Missing invite token');
    return;
  }
  res.render('invite', { token, error: undefined });
});

// ── POST /invite ───────────────────────────────────────────────────────────

inviteRouter.post('/invite', express.urlencoded({ extended: false }), async (req, res) => {
  const { token, username, password } = req.body as Record<string, string>;

  if (!token || !username || !password) {
    res.status(400).render('invite', { token: token ?? '', error: 'All fields are required.' });
    return;
  }

  if (password.length < 8) {
    res.status(400).render('invite', {
      token,
      error: 'Password must be at least 8 characters.',
    });
    return;
  }

  const outcome = await redeemInvite({ token, username, password });

  if (!outcome.ok) {
    const messages: Record<typeof outcome.error, string> = {
      INVALID_TOKEN: 'This invite link is invalid.',
      EXPIRED_TOKEN: 'This invite link has expired.',
      ALREADY_USED: 'This invite link has already been used.',
      EMAIL_RACE: 'This invite link cannot be used — the email address has already been claimed.',
    };
    res.status(400).render('invite', { token, error: messages[outcome.error] });
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
