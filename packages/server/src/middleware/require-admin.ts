/**
 * Admin middleware
 *
 * Guards the /admin/api JSON endpoints. Validates the Bearer JWT (or the
 * `homectl_admin_token` cookie the SPA sends same-origin) and checks
 * isAdmin: true. Always responds with JSON — the React SPA turns a 401/403 into
 * a client-side redirect to /admin/login.
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

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers['authorization'];

  // The admin GUI is protected by an RS256 JWT carried in the httpOnly
  // `homectl_admin_token` cookie (set by the GitHub OAuth callback). API clients
  // may instead send it as a Bearer token.
  const cookieToken = (req.cookies as Record<string, string>)['homectl_admin_token'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const token = bearerToken ?? cookieToken;

  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const payload = await verifyAccessToken(token);
    if (!payload.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    res.locals['admin'] = payload;
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}
