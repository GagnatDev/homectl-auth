import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import type { Express } from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const app = createApp();

describe('GET /health', () => {
  it('returns 200 with { ok: true }', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

async function rawPost(
  expressApp: Express,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number; raw: string }> {
  const server = expressApp.listen(0);
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { ...headers, 'content-length': String(body.length) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              raw: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } finally {
    server.close();
  }
}

// body-parser 1.20.9 / 2.4.0 (pulled in by Express) fix CVE-2026-111181:
// trailing bytes after a compressed body used to become an uncaught exception
// and kill the process after the request had already been handled.
describe('compressed JSON bodies (CVE-2026-111181)', () => {
  it('does not crash when a gzip JSON body has trailing bytes', async () => {
    const compressed = gzipSync(Buffer.from('{"grant_type":"nope"}'));
    const poisoned = Buffer.concat([compressed, Buffer.from('\0trailing')]);

    const res = await rawPost(
      app,
      '/token',
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      poisoned,
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.raw)).toMatchObject({ error: 'unsupported_grant_type' });

    // Give the leftover decoder a turn to emit the trailing-byte error, then
    // prove the process is still serving requests.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
  });
});
