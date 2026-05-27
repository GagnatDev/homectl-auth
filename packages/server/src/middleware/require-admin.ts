/**
 * Admin middleware
 *
 * Validates the Bearer JWT and checks isAdmin: true.
 * - API requests (no Accept: text/html) → 401/403 JSON
 * - Browser requests (Accept: text/html) → redirect to /authorize
 */

import { type Request, type Response, type NextFunction } from 'express';
import { verifyAccessToken, type AccessTokenPayload } from '../modules/token/token.service';

declare global {
  namespace Express {
    interface Locals {
      admin: AccessTokenPayload;
    }
  }
}

function isHtmlRequest(req: Request): boolean {
  const accept = req.headers['accept'] ?? '';
  return accept.includes('text/html');
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers['authorization'];

  // Check for cookie-based access token (admin GUI uses a cookie in Phase 5)
  // For simplicity in v1: the admin GUI is protected by Bearer JWT embedded in
  // a cookie named `homectl_admin_token`. This avoids needing a separate session.
  const cookieToken = (req.cookies as Record<string, string>)['homectl_admin_token'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const token = bearerToken ?? cookieToken;

  if (!token) {
    if (isHtmlRequest(req)) {
      // Redirect to login — in v1 the admin uses the same login flow
      res.redirect(302, '/admin/login');
    } else {
      res.status(401).json({ error: 'unauthorized' });
    }
    return;
  }

  try {
    const payload = await verifyAccessToken(token);
    if (!payload.isAdmin) {
      if (isHtmlRequest(req)) {
        res.status(403).render('admin/error', { message: 'Admin access required.' });
      } else {
        res.status(403).json({ error: 'forbidden' });
      }
      return;
    }
    res.locals['admin'] = payload;
    next();
  } catch {
    if (isHtmlRequest(req)) {
      res.redirect(302, '/admin/login');
    } else {
      res.status(401).json({ error: 'invalid_token' });
    }
  }
}
