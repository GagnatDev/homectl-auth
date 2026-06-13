/**
 * Serving the React SPA shell.
 *
 * The GUI is a Vite-built single-page app (packages/web). Express serves its
 * static assets and returns the same `index.html` shell for every GUI page
 * route; React Router takes over client-side. The public OAuth page handlers
 * (authorize/invite/reset-password) and the admin GUI routes all funnel through
 * `serveShell` so their server-side logic (redirect-URI validation, the SSO
 * 302, the GitHub state cookie) runs first and then hands off to the SPA.
 *
 * In production the bundle is copied next to the compiled server (dist/web). In
 * development the SPA is served by the Vite dev server (its own port + proxy),
 * so the bundle may be absent here — we return a clear hint instead of a raw
 * ENOENT in that case.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { type Response } from 'express';

/** Directory holding the built SPA (index.html + hashed assets). */
export const WEB_DIST_DIR = process.env['WEB_DIST_DIR'] ?? join(__dirname, 'web');

const INDEX_HTML = join(WEB_DIST_DIR, 'index.html');

export function serveShell(res: Response): void {
  if (!existsSync(INDEX_HTML)) {
    res
      .status(500)
      .type('text/plain')
      .send(
        'Web bundle not found. Run `pnpm --filter @homectl/web build`, or use ' +
          'the Vite dev server (pnpm --filter @homectl/web dev) for GUI work.',
      );
    return;
  }
  res.sendFile(INDEX_HTML);
}
