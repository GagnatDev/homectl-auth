import { readFileSync } from 'fs';
import { join } from 'path';
import { POSTGRES_URI_FILE } from './vitest.constants';

// Make the container's connection string available to all test workers
const uri = readFileSync(POSTGRES_URI_FILE, 'utf-8').trim();
process.env['DATABASE_URL'] = uri;
process.env['NODE_ENV'] = 'test';

// The GUI page routes serve the built React SPA shell. Tests don't build the
// web bundle, so point WEB_DIST_DIR at a minimal fixture shell. Must be set
// before app.ts (→ web-shell.ts) is imported, which setupFiles guarantees.
process.env['WEB_DIST_DIR'] = join(__dirname, 'src/__tests__/fixtures/web');
