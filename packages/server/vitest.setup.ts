import { readFileSync } from 'fs';
import { POSTGRES_URI_FILE } from './vitest.constants';

// Make the container's connection string available to all test workers
const uri = readFileSync(POSTGRES_URI_FILE, 'utf-8').trim();
process.env['DATABASE_URL'] = uri;
process.env['NODE_ENV'] = 'test';
