/**
 * Password reset endpoints.
 *
 * GET  /reset-password?token=…  — reset form
 * POST /reset-password           — form submission
 */

import { Router, type IRouter } from 'express';
import express from 'express';
import { redeemReset } from '../modules/password-reset/password-reset.service';
import { serveShell } from '../web-shell';

export const resetPasswordRouter: IRouter = Router();

/** Bounce back to the reset form with an error code the SPA maps to a message. */
function redirectToResetError(res: import('express').Response, token: string, error: string): void {
  const q = new URLSearchParams({ token, error });
  res.redirect(302, `/reset-password?${q.toString()}`);
}

// ── GET /reset-password ────────────────────────────────────────────────────

resetPasswordRouter.get('/reset-password', (req, res) => {
  const { token } = req.query as Record<string, string>;
  if (!token) {
    res.status(400).send('Missing reset token');
    return;
  }
  // The SPA reset page reads the token + error from the query string.
  serveShell(res);
});

// ── POST /reset-password ───────────────────────────────────────────────────

resetPasswordRouter.post(
  '/reset-password',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const { token, password } = req.body as Record<string, string>;

    if (!token || !password) {
      redirectToResetError(res, token ?? '', 'missing_fields');
      return;
    }

    if (password.length < 8) {
      redirectToResetError(res, token, 'password_too_short');
      return;
    }

    const outcome = await redeemReset({ token, newPassword: password });

    if (!outcome.ok) {
      redirectToResetError(res, token, outcome.error);
      return;
    }

    // Redirect to login
    res.redirect(302, '/?password_reset=1');
  },
);
