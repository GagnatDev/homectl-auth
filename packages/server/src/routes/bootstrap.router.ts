/**
 * Bootstrap admin registration.
 *
 * GET  /bootstrap/admin  — registration form
 * POST /bootstrap/admin  — form submission
 *
 * Available only when no admin user exists and BOOTSTRAP_ADMIN_EMAIL is set.
 * Disabled permanently once the first admin is registered.
 */

import { Router, type IRouter } from 'express';
import express from 'express';
import { bootstrapAdmin } from '../modules/bootstrap/bootstrap.service';

export const bootstrapRouter: IRouter = Router();

const GENERIC_ERROR = 'Bootstrap registration is not available.';

bootstrapRouter.get('/bootstrap/admin', (_req, res) => {
  res.render('bootstrap', { error: undefined });
});

bootstrapRouter.post(
  '/bootstrap/admin',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const { username, password, email } = req.body as Record<string, string>;

    if (!username || !password || !email) {
      res.status(400).render('bootstrap', { error: 'All fields are required.' });
      return;
    }

    const outcome = await bootstrapAdmin({ username, password, submittedEmail: email });

    if (!outcome.ok) {
      if (outcome.error === 'WEAK_PASSWORD') {
        res.status(400).render('bootstrap', {
          error: 'Password must be at least 8 characters.',
        });
        return;
      }
      res.status(403).render('bootstrap', { error: GENERIC_ERROR });
      return;
    }

    res.redirect(302, '/bootstrap/admin/success');
  },
);

bootstrapRouter.get('/bootstrap/admin/success', (_req, res) => {
  res.render('bootstrap-success');
});
