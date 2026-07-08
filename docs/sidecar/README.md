# `homectl-auth-proxy` — forward-auth sidecar (sketch, **superseded**)

> **⚠️ Superseded.** The sidecar is now implemented for real in
> [`packages/proxy`](../../packages/proxy) and shipped as the `homectl-auth-proxy`
> Docker image (`Dockerfile.proxy`). Use the production guides, not this sketch:
>
> - **[integration.md](./integration.md)** — adopt the sidecar in a new app
>   (config, full K8s manifest, reading identity, local dev, security).
> - **[migration.md](./migration.md)** — move an app off
>   `@gagnatdev/homectl-auth-client`.
> - **[troubleshooting.md](./troubleshooting.md)** — every known failure mode.
>
> This file is kept for historical context only. The real implementation
> differs in a few details (env vars are `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET`;
> it adds CSRF `state` verification, `/readyz`, structured logging, timeouts,
> and reuses the `homectl_refresh_<clientId>` cookie for the first refresh
> token). Prefer the guides above.

A reference sketch of the forward-auth sidecar described in
[ADR 0001](../adr/0001-forward-auth-sidecar.md). It is intentionally minimal —
enough to show the flow, the state model, and the contract with homectl-auth.

## What it does

```
Browser ──▶ Ingress ──▶ sidecar :4180 ──▶ app :3000
                              │
                              └── in-cluster ──▶ homectl-auth ClusterIP
                                    /authorize (browser 302, public URL)
                                    /token           (code exchange)
                                    /internal/refresh (token refresh)
```

Per request the sidecar:

1. Reads its own encrypted session cookie (`hs_session`). No session → start the
   authorization-code flow (302 the browser to the **public** `/authorize`).
2. Handles `/auth/callback`: verifies `state`, exchanges the code in-cluster,
   captures the refresh token, and writes the encrypted session cookie.
3. Ensures a fresh access token: if the cached one is near expiry, calls
   `POST /internal/refresh` in-cluster and re-writes the session cookie with the
   rotated refresh token.
4. **Strips** any inbound `Authorization` / `X-Homectl-*` headers, injects its
   own, and proxies to the app.

The browser holds only `hs_session`. The app backend reads a trusted header and
does no auth work. The frontend is entirely auth-agnostic.

## State model (why no Redis)

The session is encapsulated in the encrypted cookie, so any replica can serve
any request as long as they share `COOKIE_KEY`. The durable session lives in
homectl-auth's `sessions` table. See ADR 0001 §"Session strategy across
multiple pods" for the refresh-rotation race and the recommended grace window.

## Configuration

| Env var | Example | Notes |
|---|---|---|
| `PUBLIC_AUTH_URL` | `https://auth.homectl.no` | Browser redirects + JWT `iss`. |
| `INTERNAL_AUTH_URL` | `http://homectl-auth.homectl` | In-cluster ClusterIP. |
| `CLIENT_ID` | `workbench` | Registered app id. |
| `CLIENT_SECRET` | _(from Secret)_ | For `/token` + `/internal/refresh`. |
| `APP_BASE_URL` | `https://workbench.homectl.no` | Public base; builds `redirect_uri`. |
| `UPSTREAM` | `http://127.0.0.1:3000` | The app container in the same pod. |
| `COOKIE_KEY` | _(32-byte base64, from Secret)_ | Shared across replicas. |
| `LISTEN_PORT` | `4180` | Ingress targets this. |

## Reference implementation (sketch)

> Sketch-quality: happy path, minimal error handling, cookie crypto shown
> explicitly. Harden before production (CSRF on callback, cookie chunking for
> size, structured logging, timeouts, retries).

```ts
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'crypto';

const {
  PUBLIC_AUTH_URL,
  INTERNAL_AUTH_URL,
  CLIENT_ID,
  CLIENT_SECRET,
  APP_BASE_URL,
  UPSTREAM,
  COOKIE_KEY, // base64, 32 bytes
  LISTEN_PORT = '4180',
} = process.env as Record<string, string>;

const REDIRECT_URI = `${APP_BASE_URL}/auth/callback`;
const SESSION_COOKIE = 'hs_session';
const REFRESH_SKEW_S = 60; // refresh this many seconds before expiry
const KEY = Buffer.from(COOKIE_KEY, 'base64');

const JWKS = createRemoteJWKSet(new URL(`${INTERNAL_AUTH_URL}/.well-known/jwks.json`));

// ── Session cookie: AES-256-GCM over a small JSON blob ──────────────────────
type Session = {
  refreshToken: string;
  accessToken: string;
  accessExp: number; // epoch seconds
  sub: string;
  email: string;
  role: string | null;
};

function seal(s: Session): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(s), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

function open(v: string | undefined): Session | null {
  if (!v) return null;
  try {
    const [iv, tag, body] = v.split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

function setSession(res: express.Response, s: Session) {
  res.cookie(SESSION_COOKIE, seal(s), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax', // 'lax' so the post-login top-level redirect carries it
    path: '/',
  });
}

// ── homectl-auth calls ──────────────────────────────────────────────────────
async function exchangeCode(code: string): Promise<{ refreshFromCookie: boolean }> {
  // The code exchange itself validates the client. In the current design the
  // refresh cookie is set by auth during /login on domain=.homectl.no — but a
  // sidecar-owned model should instead hold the refresh token itself. This
  // sketch assumes homectl-auth returns a refresh token to the exchanger; wire
  // it to whatever the /token (or a future /internal/token) response provides.
  const r = await fetch(`${INTERNAL_AUTH_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!r.ok) throw new Error('token_exchange_failed');
  return { refreshFromCookie: true };
}

async function refresh(refreshToken: string): Promise<Session> {
  const r = await fetch(`${INTERNAL_AUTH_URL}/internal/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  if (!r.ok) throw new Error(`refresh_failed_${r.status}`);
  const t = await r.json();
  const { payload } = await jwtVerify(t.access_token, JWKS, {
    issuer: PUBLIC_AUTH_URL,
    audience: CLIENT_ID,
    algorithms: ['RS256'],
  });
  const apps = (payload.apps as Array<{ appId: string; role: string }>) ?? [];
  return {
    refreshToken: t.refresh_token, // rotated — must be persisted
    accessToken: t.access_token,
    accessExp: payload.exp as number,
    sub: payload.sub as string,
    email: payload.email as string,
    role: apps.find((a) => a.appId === CLIENT_ID)?.role ?? null,
  };
}

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();

// Callback: exchange code, establish the sidecar session, bounce to originalUrl.
app.get('/auth/callback', async (req, res) => {
  // TODO: verify `state` against a signed pre-auth cookie (CSRF).
  const code = String(req.query.code ?? '');
  if (!code) return res.status(400).send('missing_code');
  try {
    await exchangeCode(code);
    // Obtain the first refresh token here (see exchangeCode note), then:
    // const session = await refresh(firstRefreshToken);
    // setSession(res, session);
    res.redirect(String(req.query.rd ?? '/'));
  } catch {
    res.status(502).send('auth_upstream_error');
  }
});

// Everything else: ensure identity, inject headers, proxy.
app.use(async (req, res, next) => {
  let session = open(req.headers.cookie?.match(/hs_session=([^;]+)/)?.[1]);

  if (!session) {
    // No session → start login. Only bounce top-level navigations; APIs get 401.
    if ((req.headers.accept ?? '').includes('text/html')) {
      const u = new URL(`${PUBLIC_AUTH_URL}/authorize`);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', CLIENT_ID);
      u.searchParams.set('redirect_uri', REDIRECT_URI);
      u.searchParams.set('state', randomBytes(16).toString('hex')); // persist + verify
      return res.redirect(302, u.toString());
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Refresh proactively when close to expiry.
  const now = Math.floor(Date.now() / 1000);
  if (session.accessExp - now < REFRESH_SKEW_S) {
    try {
      session = await refresh(session.refreshToken);
      setSession(res, session);
    } catch {
      res.clearCookie(SESSION_COOKIE);
      return res.redirect(302, `${PUBLIC_AUTH_URL}/authorize?...`);
    }
  }

  // Strip spoofable inbound headers, then inject trusted identity.
  delete req.headers['authorization'];
  for (const h of Object.keys(req.headers)) {
    if (h.toLowerCase().startsWith('x-homectl-')) delete req.headers[h];
  }
  req.headers['authorization'] = `Bearer ${session.accessToken}`;
  req.headers['x-homectl-user'] = session.sub;
  req.headers['x-homectl-email'] = session.email;
  if (session.role) req.headers['x-homectl-role'] = session.role;
  next();
});

app.use(createProxyMiddleware({ target: UPSTREAM, changeOrigin: false }));

app.listen(Number(LISTEN_PORT));
```

## A note on the first refresh token

The sidecar-owned model works cleanly once it holds a refresh token. Two ways to
get the first one after the code exchange:

- **Reuse today's cookie.** homectl-auth already sets `homectl_refresh_<clientId>`
  on `domain=.homectl.no` during `/login`, so it arrives at the app host. The
  sidecar can read it once, then manage rotation itself via `/internal/refresh`.
  Lowest-change path; keeps the browser cookie in play.
- **Return it from exchange (cleaner).** Add a server-to-server exchange variant
  that returns the refresh token in the JSON body (like `/internal/refresh`
  does), so the browser never receives a refresh cookie at all. Recommended
  end-state; a small follow-up to homectl-auth.

See the ADR's implementation checklist.
