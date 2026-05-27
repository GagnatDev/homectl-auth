/**
 * CORS middleware for browser-to-auth-service endpoints (/refresh, /logout).
 *
 * Emits:
 *   Access-Control-Allow-Origin: <exact origin from allow-list>
 *   Access-Control-Allow-Credentials: true
 *
 * Rejects requests from origins not in any app's allowedOrigins list.
 */

import { type Request, type Response, type NextFunction } from 'express';
import { getAllApps } from '../config/apps';

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const app of getAllApps()) {
    for (const origin of app.allowedOrigins) {
      origins.add(origin);
    }
  }
  return origins;
}

export function credentialsCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers['origin'];

  if (req.method === 'OPTIONS') {
    // Preflight
    if (origin && getAllowedOrigins().has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Vary', 'Origin');
    }
    res.status(204).end();
    return;
  }

  if (origin) {
    if (getAllowedOrigins().has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    } else {
      res.status(403).json({ error: 'forbidden_origin' });
      return;
    }
  }

  next();
}
