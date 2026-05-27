import { tmpdir } from 'os';
import { join } from 'path';

export const POSTGRES_URI_FILE = join(tmpdir(), 'homectl-auth-vitest-postgres-uri');
