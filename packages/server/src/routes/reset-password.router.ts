/**
 * Password reset endpoints.
 *
 * GET  /reset-password?token=…  — reset form
 * POST /reset-password           — form submission
 */

import { Router, type IRouter } from 'express';
import express from 'express';
import { redeemReset } from '../modules/password-reset/password-reset.service';

export const resetPasswordRouter: IRouter = Router();

// ── GET /reset-password ────────────────────────────────────────────────────

resetPasswordRouter.get('/reset-password', (req, res) => {
  const { token } = req.query as Record<string, string>;
  if (!token) {
    res.status(400).send('Missing reset token');
    return;
  }
  res.render('reset-password', { token, error: undefined });
});

// ── POST /reset-password ───────────────────────────────────────────────────

resetPasswordRouter.post(
  '/reset-password',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const { token, password } = req.body as Record<string, string>;

    if (!token || !password) {
      res.status(400).render('reset-password', {
        token: token ?? '',
        error: 'All fields are required.',
      });
      return;
    }

    if (password.length < 8) {
      res.status(400).render('reset-password', {
        token,
        error: 'Password must be at least 8 characters.',
      });
      return;
    }

    const outcome = await redeemReset({ token, newPassword: password });

    if (!outcome.ok) {
      const messages: Record<typeof outcome.error, string> = {
        INVALID_TOKEN: 'This reset link is invalid.',
        EXPIRED_TOKEN: 'This reset link has expired.',
        ALREADY_USED: 'This reset link has already been used.',
        USER_NOT_FOUND: 'Account not found.',
      };
      res.status(400).render('reset-password', { token, error: messages[outcome.error] });
      return;
    }

    // Redirect to login
    res.redirect(302, '/?password_reset=1');
  },
);
