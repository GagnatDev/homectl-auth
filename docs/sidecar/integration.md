# Integrating an app with the `homectl-auth-proxy` sidecar

This is the **recommended** way to add homectl-auth to an app. You add one
container to your pod, point ingress at it, and read the authenticated user
from a request header. Your **frontend holds no token and makes only
same-origin requests**, and your **backend does no auth work**.

If you are migrating an existing app off `@gagnatdev/homectl-auth-client`, read
this first, then follow [`migration.md`](./migration.md). When something breaks,
[`troubleshooting.md`](./troubleshooting.md) lists every failure mode we have
actually hit.

---

## 1. The concept in one diagram

```
Browser ──HTTPS──▶ Ingress ──▶ ┌ pod ─────────────────────────────────┐
   holds only                  │  auth-proxy :4180  ──▶  your app :3000 │
   hs_session cookie           │        │                              │
                               └────────┼──────────────────────────────┘
                                        │ in-cluster (ClusterIP), never public ingress
                                        ▼
                               homectl-auth
                                 /authorize         ← browser 302 (PUBLIC url only)
                                 /token             ← code exchange
                                 /internal/refresh  ← token refresh (rotates)
                                 /.well-known/jwks.json
```

Who does what:

| Actor | Responsibility |
|---|---|
| **Browser** | Holds only the sidecar's opaque `hs_session` cookie. Makes plain same-origin `fetch` calls. Knows nothing about homectl-auth. |
| **Sidecar** | Runs the OAuth flow, keeps a session in an encrypted cookie, refreshes tokens in-cluster, injects a verified identity header, proxies to your app. |
| **Your app** | Reads `X-Homectl-User` / `-Email` / `-Role` (and/or the `Authorization: Bearer` JWT). Enforces its own authorization. No token handling. |
| **homectl-auth** | Unchanged. Issues codes, exchanges them, rotates refresh tokens, publishes JWKS. |

Per request the sidecar:

1. Reads and decrypts its `hs_session` cookie. No session → for an HTML
   navigation it 302s to central login; for an XHR it returns `401`.
2. On the callback path it verifies the CSRF `state`, exchanges the code
   in-cluster, and writes the encrypted session cookie.
3. If the cached access token is near expiry it calls `/internal/refresh`
   in-cluster and rewrites the cookie with the rotated refresh token.
4. **Strips** any inbound `Authorization` / `X-Homectl-*` headers, injects its
   own trusted values, and proxies to your app.

---

## 2. Register the app

The sidecar is a normal homectl-auth OAuth client, so registration is exactly
the same as for a library app — see the main README's
[**Integrating a New App → Register the app**](../../README.md#integrating-a-new-app)
and **Generate and store the client secret**. In short:

Add an entry to `apps.json`:

```json
{
  "id": "workbench",
  "name": "Workbench",
  "clientSecretEnv": "WORKBENCH_CLIENT_SECRET",
  "allowedRedirectUris": ["https://workbench.homectl.no/auth/callback"],
  "allowedOrigins": ["https://workbench.homectl.no"],
  "roles": [
    { "name": "member", "rank": 1 },
    { "name": "admin", "rank": 2 }
  ]
}
```

- `allowedRedirectUris` **must** contain `${APP_BASE_URL}${CALLBACK_PATH}` — with
  the defaults that is `https://workbench.homectl.no/auth/callback`. This is the
  URL the sidecar sends as `redirect_uri`; a mismatch is rejected by
  `/authorize` and `/token`.
- `allowedOrigins` should include your app's public origin. The sidecar does not
  use the `Origin`-based `/refresh` path, but keeping the origin listed avoids
  surprises and matches the library apps.

Generate the client secret and store **both** halves:

```bash
SECRET=$(openssl rand -hex 32)
echo "plaintext (goes in the app's Secret): $SECRET"
node -e "require('bcryptjs').hash('$SECRET', 12).then(console.log)"   # hash → homectl-auth's Secret
```

- homectl-auth stores the **bcrypt hash** under `clientSecretEnv`
  (`WORKBENCH_CLIENT_SECRET`) in the `homectl` namespace, exactly as today.
- The sidecar stores the **plaintext** secret as `AUTH_CLIENT_SECRET` in the
  app's own Secret (below). It presents it to `/token` and `/internal/refresh`,
  which bcrypt-compare it against the stored hash.

---

## 3. Kubernetes wiring

A complete, production-shaped manifest. Substitute the five clearly marked
values; everything else is copy-paste. (A minimal sketch lives in
[`deployment.example.yaml`](./deployment.example.yaml).)

```yaml
# ── Secret: the two values the sidecar needs ──────────────────────────────────
apiVersion: v1
kind: Secret
metadata:
  name: workbench-auth               # ← your app
  namespace: homectl
type: Opaque
stringData:
  # Plaintext client secret (homectl-auth stores the bcrypt hash of this).
  AUTH_CLIENT_SECRET: "REPLACE_WITH_PLAINTEXT_SECRET"        # ← substitute
  # 32-byte base64 key for cookie encryption. Generate: openssl rand -base64 32
  # MUST be identical across every replica (it is one Secret, so it is).
  COOKIE_KEY: "REPLACE_WITH_openssl_rand_base64_32"          # ← substitute
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workbench                    # ← your app
  namespace: homectl
spec:
  # Multi-pod is safe: the sidecar is stateless (session lives in the encrypted
  # cookie) and all replicas share COOKIE_KEY, so any request can hit any pod.
  # No Redis, no sticky sessions.
  replicas: 3
  selector:
    matchLabels:
      app: workbench
  template:
    metadata:
      labels:
        app: workbench
    spec:
      containers:
        # ── Your app ──────────────────────────────────────────────────────────
        # Listens on loopback / pod-local only. It must NEVER be exposed to the
        # ingress directly — only the sidecar may reach it (see Security below).
        - name: app
          image: rg.fr-par.scw.cloud/homectl/workbench:latest   # ← your image
          ports:
            - name: http
              containerPort: 3000
          resources:
            requests: { cpu: "50m", memory: "128Mi" }
            limits: { cpu: "500m", memory: "512Mi" }

        # ── Auth sidecar ──────────────────────────────────────────────────────
        - name: auth-proxy
          image: rg.fr-par.scw.cloud/homectl/homectl-auth-proxy:latest
          ports:
            - name: proxy
              containerPort: 4180
          env:
            - name: PUBLIC_AUTH_URL
              value: https://auth.homectl.no
            - name: INTERNAL_AUTH_URL
              value: http://homectl-auth.homectl        # ClusterIP Service
            - name: APP_BASE_URL
              value: https://workbench.homectl.no        # ← your public host
            - name: UPSTREAM
              value: http://127.0.0.1:3000               # the app container above
            - name: AUTH_CLIENT_ID
              value: workbench                           # ← your apps.json id
            - name: AUTH_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: workbench-auth
                  key: AUTH_CLIENT_SECRET
            - name: COOKIE_KEY
              valueFrom:
                secretKeyRef:
                  name: workbench-auth
                  key: COOKIE_KEY
            - name: NODE_ENV
              value: production
          readinessProbe:
            httpGet: { path: /readyz, port: 4180 }        # verifies JWKS reachable
            initialDelaySeconds: 3
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /healthz, port: 4180 }
            initialDelaySeconds: 3
            periodSeconds: 15
          resources:
            requests: { cpu: "25m", memory: "64Mi" }
            limits: { cpu: "250m", memory: "256Mi" }
---
apiVersion: v1
kind: Service
metadata:
  name: workbench
  namespace: homectl
spec:
  selector:
    app: workbench
  ports:
    - name: http
      port: 80
      targetPort: 4180            # → the SIDECAR, never the app's 3000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: workbench
  namespace: homectl
  annotations:
    # Defense in depth: never serve /internal/* from a public host.
    nginx.ingress.kubernetes.io/server-snippet: |
      location ~ ^/internal/ { return 404; }
spec:
  rules:
    - host: workbench.homectl.no
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: workbench
                port:
                  number: 80
```

The critical wiring facts: **ingress → Service:80 → sidecar:4180 → app:3000**.
The app port is never a Service target and never an ingress backend.

---

## 4. Reading identity in your app

On every proxied request the sidecar injects these headers (and guarantees no
client-supplied copy survives — see Security):

| Header | Value | Source |
|---|---|---|
| `Authorization` | `Bearer <jwt>` | The verified RS256 access token. |
| `X-Homectl-User` | user id | JWT `sub`. |
| `X-Homectl-Email` | email | JWT `email`. |
| `X-Homectl-Role` | app role, e.g. `admin` | The `apps[]` entry matching this app's `client_id`. Omitted if the user has no role in this app. |

The JWT claim shape (cross-linked from the main PRD's
[**Token claims**](../../README.md#token-claims)):

```json
{
  "iss": "https://auth.homectl.no",
  "aud": "workbench",
  "sub": "user-uuid",
  "email": "user@example.com",
  "isAdmin": false,
  "apps": [{ "appId": "workbench", "role": "admin" }],
  "iat": 1710000000,
  "exp": 1710000900
}
```

You can trust `X-Homectl-*` directly (the sidecar already verified the token).
The `Authorization` bearer is there if you prefer to verify the JWT yourself.

**Node / Express:**

```js
app.use((req, res, next) => {
  req.user = {
    id: req.get('x-homectl-user'),
    email: req.get('x-homectl-email'),
    role: req.get('x-homectl-role') ?? null,
  };
  if (!req.user.id) return res.status(401).json({ error: 'unauthenticated' });
  next();
});

app.get('/api/reports', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  res.json({ owner: req.user.email });
});
```

**Python / Flask** (proving it is language-agnostic — any framework that can
read a header works):

```python
from flask import request, g, abort

@app.before_request
def load_identity():
    g.user_id = request.headers.get("X-Homectl-User")
    g.email = request.headers.get("X-Homectl-Email")
    g.role = request.headers.get("X-Homectl-Role")
    if not g.user_id:
        abort(401)

@app.get("/api/reports")
def reports():
    if g.role != "admin":
        abort(403)
    return {"owner": g.email}
```

---

## 5. Frontend expectations

The SPA is completely auth-agnostic. No `bootstrap()`, no `authedFetch`, no
knowledge of `auth.homectl.no`. Just same-origin calls:

```js
const res = await fetch('/api/reports');   // no Authorization header, no token
if (res.status === 401) {
  // The session expired or was never established. For an XHR the sidecar
  // returns 401 (it never redirects an XHR). Bounce to a full page load so the
  // sidecar can do the top-level login redirect for you:
  window.location.href = '/';
}
const data = await res.json();
```

That is the whole contract: for a **top-level navigation** the sidecar handles
the login redirect; for an **XHR** it returns `401` and the SPA decides what to
do (typically reload to trigger the navigation redirect).

---

## 6. Configuration reference

All configuration is via environment variables, validated once at startup. A
missing or malformed value prints every problem and exits non-zero.

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PUBLIC_AUTH_URL` | yes | — | Browser redirect target **and** the JWT `iss` verified on every token. e.g. `https://auth.homectl.no`. |
| `INTERNAL_AUTH_URL` | yes | — | In-cluster ClusterIP base for `/token`, `/internal/refresh`, and JWKS. e.g. `http://homectl-auth.homectl`. |
| `AUTH_CLIENT_ID` | yes | — | The app's registered id (JWT `aud`). |
| `AUTH_CLIENT_SECRET` | yes | — | Plaintext client secret for `/token` + `/internal/refresh`. Store in a Secret. |
| `APP_BASE_URL` | yes | — | The app's public base URL; builds `redirect_uri` = `APP_BASE_URL + CALLBACK_PATH`. |
| `UPSTREAM` | yes | — | The app container in the same pod, e.g. `http://127.0.0.1:3000`. |
| `COOKIE_KEY` | yes | — | 32-byte base64 AES-256-GCM key. **Identical across all replicas.** Generate: `openssl rand -base64 32`. |
| `CALLBACK_PATH` | no | `/auth/callback` | Path the sidecar handles for the code exchange. |
| `LOGOUT_PATH` | no | `/auth/logout` | Path the sidecar handles for logout (clears `hs_session`). |
| `LISTEN_PORT` | no | `4180` | Port ingress targets. |
| `REFRESH_SKEW_SECONDS` | no | `60` | Refresh this many seconds before the access token expires. |
| `SESSION_COOKIE_NAME` | no | `hs_session` | Name of the sidecar's encrypted session cookie. |
| `DEV_FAKE_IDENTITY` | no (dev only) | — | See Local development. **Fatal if set when `NODE_ENV=production`.** |

The sidecar also honors `LOG_LEVEL` (pino levels; default `info`) and
`NODE_ENV`.

---

## 7. Local development

You usually do not want a full cluster to run your app. Two options:

### Option A — bypass the sidecar entirely

In local dev, just run your app directly and skip the proxy. Read identity from
an env-driven stub, or default to a fixed local user when the `X-Homectl-*`
headers are absent. This is the simplest path and needs nothing from the
sidecar.

### Option B — run the sidecar with a fake identity (`DEV_FAKE_IDENTITY`)

If you want the sidecar in the loop locally (to exercise the real proxying) but
without a login flow, set `DEV_FAKE_IDENTITY` to a JSON identity. The sidecar
then **skips the entire OAuth flow** and injects that identity on every request:

```bash
docker run --rm -p 4180:4180 \
  -e NODE_ENV=development \
  -e PUBLIC_AUTH_URL=https://auth.homectl.no \
  -e INTERNAL_AUTH_URL=http://localhost:9999 \
  -e AUTH_CLIENT_ID=workbench \
  -e AUTH_CLIENT_SECRET=dev \
  -e APP_BASE_URL=http://localhost:4180 \
  -e UPSTREAM=http://host.docker.internal:3000 \
  -e COOKIE_KEY="$(openssl rand -base64 32)" \
  -e DEV_FAKE_IDENTITY='{"sub":"dev-user","email":"dev@homectl.no","role":"admin"}' \
  rg.fr-par.scw.cloud/homectl/homectl-auth-proxy:latest
```

In this mode only the `X-Homectl-*` headers are injected (there is no signing
key, so no `Authorization` bearer). Your app should therefore key its dev auth
off `X-Homectl-*`.

> **DEV_FAKE_IDENTITY is a development-only escape hatch and must NEVER be set
> in production.** It bypasses authentication completely. The sidecar refuses to
> start if `DEV_FAKE_IDENTITY` is set while `NODE_ENV=production`.

---

## 8. Security notes

These are not optional — they are what makes the injected header trustworthy.

- **The app must be reachable only through the sidecar.** The Service targets
  `4180` (the sidecar); the app's `3000` is pod-local. If the app were exposed
  to the ingress directly, a client could set `X-Homectl-User` itself and
  impersonate anyone. Never add an ingress path or Service that reaches the app
  port.
- **Header-stripping guarantee.** On every proxied request the sidecar deletes
  the inbound `Authorization` header and **every** `X-Homectl-*` header before
  injecting its own. So your app may trust those headers *provided* the previous
  point holds. (There is a regression test asserting a forged inbound header is
  stripped.)
- **Restrict `/internal/*` to in-cluster traffic.** `/internal/refresh` is
  client-secret authenticated (no worse than `/token`), but keep it off the
  public surface as defense in depth. Use the ingress `server-snippet` shown in
  §3 and/or a `NetworkPolicy` allowing `/internal/*` only from in-cluster
  sources.
- **CSRF on callback.** The sidecar sets a signed, single-use `state` cookie
  before redirecting to `/authorize` and rejects a callback whose `state` does
  not match. A forged callback cannot establish a session.
- **Cookie flags.** `hs_session` is `HttpOnly`, `Secure` (in production),
  `SameSite=Lax` (so the post-login top-level redirect carries it), `Path=/`,
  AES-256-GCM with an authentication tag. A tampered cookie fails to open.
- **No token in the browser.** The JWT never leaves the pod; the browser holds
  only the opaque `hs_session` cookie. This removes the XSS token-exfiltration
  surface the in-memory-token model still carries.
- **Cookie-key rotation.** `COOKIE_KEY` is a shared secret. To rotate it, update
  the Secret and restart the pods; in-flight sessions sealed with the old key
  will fail to open and users simply re-login (the durable session still lives
  in homectl-auth, and SSO short-circuits the re-login). Rotate on a schedule
  and on suspected compromise, like any secret.

---

## 9. How the first refresh token is obtained

The sidecar drives `/internal/refresh`, which needs a refresh token to start.
This version uses the **reuse-the-existing-cookie** approach: homectl-auth
already sets `homectl_refresh_<clientId>` on `Domain=.homectl.no` during login,
so it reaches the app host. On the callback the sidecar reads that cookie once,
stores it in the encrypted session, and owns rotation from then on via
`/internal/refresh`.

A cleaner end-state (a server-to-server code-exchange variant that returns the
refresh token in the JSON body, so the browser never receives a refresh cookie)
is a tracked follow-up on homectl-auth. Adopting it later requires **no app
change** — only the sidecar's callback changes. See
[ADR 0001](../adr/0001-forward-auth-sidecar.md).
