# homectl-auth

Centralized authentication service for the `homectl.no` domain. Deployed at `auth.homectl.no`.

Issues RS256-signed JWTs to all apps on the domain. Users have one account and one set of credentials. The service handles login, session management, invites, and password resets. An admin GUI lets the operator manage users, app access, and generate invite/reset links.

## Packages

| Package | Description |
|---|---|
| `packages/server` | The auth service — Express + TypeScript + Postgres |
| `packages/web` | The GUI — a React + TypeScript + Tailwind (shadcn/ui) SPA, built with Vite and served by the server |
| `packages/client` | `@gagnatdev/homectl-auth-client` — integration library for consuming apps |
| `packages/proxy` | `homectl-auth-proxy` — forward-auth sidecar; a deployable Docker image (not published to npm) that runs beside a consuming app. See [docs/sidecar/integration.md](docs/sidecar/integration.md) |

## Quick Start (local dev)

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker (for Postgres via Testcontainers in tests, or run Postgres locally for dev)

### Install

```bash
pnpm install
```

### Environment

```bash
cp .env.example .env.local
# Edit .env.local with your local Postgres URL and a generated RS256 key pair
```

Generate an RS256 key pair:

```bash
openssl genrsa -out private_key.pem 2048
openssl rsa -in private_key.pem -pubout -out public_key.pem
# Base64-encode for the env vars:
base64 -w0 < private_key.pem   # → RS256_PRIVATE_KEY_PEM
base64 -w0 < public_key.pem    # → RS256_PUBLIC_KEY_PEM
```

Both `RS256_PRIVATE_KEY_PEM` and `RS256_PUBLIC_KEY_PEM` are required. The server signs JWTs with the private key and derives the JWKS `kid` from the public key, which is served at `/.well-known/jwks.json` for consuming apps.

### Apps config

```bash
cp apps.example.json apps.json
# Edit apps.json to match your app registrations
```

### Activity statistics

Successful logins, SSO sign-ins, and session refreshes are recorded in
`homectl_auth.activity_events` and power the admin console's **Statistics**
page (`/admin/stats`) and the per-user activity view. Refresh activity is
coalesced to at most one event per user + app + hour, so the table stays small.

Events are pruned by the hourly cleanup job after `ACTIVITY_RETENTION_DAYS`
days (optional env var, default `365`). Lowering the value later prunes the
older history on the next cleanup run.

### Run

```bash
pnpm --filter @homectl/server dev
# Server starts at http://localhost:3000
# JWKS: http://localhost:3000/.well-known/jwks.json
# Health: http://localhost:3000/health
```

### GUI (React SPA)

The login, invite, password-reset, and admin pages are a React SPA in
`packages/web`. In production it is built (`vite build`) and served by the
server as static assets — `WEB_DIST_DIR` points at the bundle (defaults to
`dist/web`, where the Docker build copies it).

For GUI development, run the Vite dev server alongside the auth server. It
proxies API and form-POST endpoints to the server (default `http://localhost:3000`;
override with `AUTH_SERVER_ORIGIN`):

```bash
pnpm --filter @homectl/server dev      # terminal 1 — API on :3000
pnpm --filter @homectl/web dev         # terminal 2 — GUI on :5173 (HMR)
```

To serve the built GUI from the server itself (production parity):

```bash
pnpm --filter @homectl/web build
WEB_DIST_DIR="$(pwd)/packages/web/dist" pnpm --filter @homectl/server dev
```

### Test

```bash
pnpm -r test          # all packages
pnpm -r typecheck     # TypeScript check
```

Tests use `@testcontainers/postgresql` — Docker must be running.

---

## Architecture

```
Browser
  │  HTTPS (TLS via cert-manager + Let's Encrypt)
  ▼
Ingress (nginx)
  │
  ▼
homectl-auth Pod (auth.homectl.no)
  │  pg
  ▼
PostgreSQL
```

### Auth flow (authorization code)

```
1. Browser hits /protected on app.homectl.no
2. App server: no token → redirect to auth.homectl.no/authorize?client_id=...&state=nonce
3. User submits credentials at auth.homectl.no/login
4. Auth service: validates credentials, verifies app access
5. Sets homectl_refresh_<clientId> cookie (HttpOnly, SameSite=Strict, domain=.homectl.no)
6. Sets homectl_sso cookie (for SSO on subsequent apps)
7. Redirects to redirect_uri?code=...&state=nonce
8. App server: exchanges code for access token (server-to-server POST /token)
9. App server: redirects browser to original URL
10. Browser: on page load, bootstrap() POSTs to auth.homectl.no/refresh (credentials: include)
11. Auth service: validates refresh cookie, rotates session, returns access token
12. Browser: stores access token in memory, attaches to all API calls as Bearer
```

### Token claims

```json
{
  "iss": "https://auth.homectl.no",
  "aud": "travel-journal",
  "sub": "user-uuid",
  "email": "user@example.com",
  "isAdmin": false,
  "apps": [{ "appId": "travel-journal", "role": "creator" }],
  "iat": 1710000000,
  "exp": 1710000900
}
```

---

## Publishing the Client Package

Publishing is triggered by pushing a Git tag matching `client-v*`. The publish workflow (`.github/workflows/publish.yml`) builds and publishes `@gagnatdev/homectl-auth-client` to GitHub Packages automatically — no manual `npm publish` needed.

### Versioning

Use [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

| Change type | Version bump | Example |
|---|---|---|
| Breaking API change | MAJOR | `0.x.x` → `1.0.0` |
| New backwards-compatible feature | MINOR | `1.0.x` → `1.1.0` |
| Bug fix, internal change | PATCH | `1.1.x` → `1.1.1` |

While the package is in initial development (`0.x.x`), minor bumps may include breaking changes.

### How to publish a new version

1. **Update the version** in `packages/client/package.json`:
   ```bash
   # From the repo root
   pnpm --filter @gagnatdev/homectl-auth-client version minor  # or major / patch
   ```

2. **Commit the version bump:**
   ```bash
   git add packages/client/package.json
   git commit -m "chore(client): bump to 1.1.0"
   ```

3. **Tag and push:**
   ```bash
   git tag client-v1.1.0
   git push origin main --tags
   ```

The `publish` workflow triggers on the tag, builds the package, and publishes it to GitHub Packages. Check the [Actions tab](../../actions/workflows/publish.yml) to confirm it succeeded.

### Checklist before publishing

- [ ] All changes are merged to `main` and CI is green
- [ ] Version in `packages/client/package.json` matches the tag you're about to create
- [ ] Breaking changes are documented (bump MAJOR, update consuming apps)

---

## Integrating a New App

There are two supported integration styles. Both are first-class; pick one.

- **Forward-auth sidecar (recommended).** Add the `homectl-auth-proxy` container
  to your pod and point ingress at it. Your **frontend holds no token and makes
  only same-origin requests**, and your **backend reads a verified identity
  header** — no auth code in either. Refresh and token exchange stay in-cluster.
  This is the path that avoids the login-loop and `Origin` footguns described in
  the [PRD](docs/prd-sidecar-proxy.md). Full walkthrough:
  **[docs/sidecar/integration.md](docs/sidecar/integration.md)** (migrating an
  existing app: [docs/sidecar/migration.md](docs/sidecar/migration.md);
  troubleshooting: [docs/sidecar/troubleshooting.md](docs/sidecar/troubleshooting.md)).

- **Client library (`@gagnatdev/homectl-auth-client`).** Wire auth into your
  Node/Express app and SPA directly, as described below. Still fully supported.

The steps below cover the **client library** path. The sidecar reuses steps 1–2
(app registration + client secret) and then replaces steps 3–5 entirely — see
its guide.

### 1. Register the app

Add an entry to `apps.json` (see `apps.example.json`):

```json
{
  "id": "my-app",
  "name": "My App",
  "clientSecretEnv": "MY_APP_CLIENT_SECRET",
  "allowedRedirectUris": ["https://my-app.homectl.no/auth/callback"],
  "allowedOrigins": ["https://my-app.homectl.no"],
  "roles": [
    { "name": "member", "rank": 1 },
    { "name": "admin", "rank": 2 }
  ]
}
```

### 2. Generate and store the client secret

**If your app is provisioned by `homectl-infra`'s Terraform** (`auth = true` in
the `applications` variable), this step is automatic: `terraform apply`
generates the secret once and writes the *same plaintext value* into both the
app's own `<app>-terraform-secrets` Secret (as `AUTH_CLIENT_ID` /
`AUTH_CLIENT_SECRET`) and into this server's shared `auth-client-secrets`
Secret (as `<APP>_CLIENT_SECRET`, matching `clientSecretEnv` above). See
homectl-infra's
[deploying-an-app.md → Auth sidecar](https://github.com/GagnatDev/homectl-infra/blob/main/docs/deploying-an-app.md#auth-sidecar-auth--true).
Nothing to run by hand — just reference `MY_APP_CLIENT_SECRET` from your app's
env (`envFrom: <app>-terraform-secrets`).

**Otherwise** (an app Terraform doesn't manage), generate one yourself and
store the *identical plaintext* value in both places — homectl-auth compares
the client secret it receives directly, with no hashing. `auth-client-secrets`
is otherwise Terraform-owned, so add the key by hand with `patch` rather than
`terraform apply` overwriting it:

```bash
SECRET=$(openssl rand -hex 32)

kubectl -n homectl patch secret auth-client-secrets --type=json -p \
  "[{\"op\":\"add\",\"path\":\"/data/MY_APP_CLIENT_SECRET\",\"value\":\"$(echo -n "$SECRET" | base64 -w0)\"}]"
kubectl -n homectl rollout restart deploy/auth   # Secret-backed env vars don't hot-reload
```

Give your app the same `$SECRET` value via its own env/Secret, then add the env
var reference to `k8s/deployment.yaml`.

### 3. Install the client package

The package is published to GitHub Packages. Consuming repos need a one-time config so npm/pnpm knows to fetch `@gagnatdev/*` from GitHub instead of the public registry.

**In the consuming repo, add (or append to) `.npmrc`:**

```
@gagnatdev:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

**Authenticate.** GitHub Packages requires a token even for read access:

- _Local dev:_ run `npm login --registry=https://npm.pkg.github.com` and use a [Personal Access Token](https://github.com/settings/tokens) with `read:packages` scope as the password. This stores credentials in `~/.npmrc` so no env var is needed.
- _CI:_ add the PAT as a repo secret. Use a name like `NPM_TOKEN`. Expose it in the install step:
  ```yaml
  - name: Install dependencies
    run: pnpm install --frozen-lockfile
    env:
      GITHUB_TOKEN: ${{ secrets.NPM_TOKEN }}
  ```

**Then install:**

```bash
pnpm add @gagnatdev/homectl-auth-client
```

### 4. Server-side middleware

```typescript
import { createAuthClient } from '@gagnatdev/homectl-auth-client/server';

const { authMiddleware, callbackHandler, logoutHandler } = createAuthClient({
  authServiceUrl: 'https://auth.homectl.no',
  clientId: 'my-app',
  clientSecret: process.env.MY_APP_CLIENT_SECRET!,
  appBaseUrl: 'https://my-app.homectl.no',
});

// Gate your API/XHR routes only — these carry `Authorization: Bearer <token>`
// via the browser helper's authedFetch and populate req.user on a valid JWT.
app.use('/api', authMiddleware);

app.get('/auth/callback', callbackHandler);
app.post('/auth/logout', logoutHandler);

// Serve your SPA / HTML shell WITHOUT authMiddleware. The page loads
// unauthenticated; the browser helper's bootstrap() then fetches the access
// token from the refresh cookie and decides whether to render the app or send
// the user to login.
app.get('*', serveSpaShell);
```

> ⚠️ **Never put `authMiddleware` in front of routes that return HTML** — and
> avoid a blanket `app.use(authMiddleware)` if the same app also serves your
> SPA. Top-level browser navigations never carry a `Bearer` header (the access
> token lives in JS memory and is only fetched by `bootstrap()` *after* the
> shell loads), so gating HTML on the bearer sends every page load to
> `/authorize` and loops straight back to the login screen. Gate `/api`
> (bearer) and serve the shell unauthenticated; let `bootstrap()` make the
> login decision.
>
> As a safety net, `authMiddleware` will **not** redirect an HTML request to
> `/authorize` when this app's refresh cookie is present (i.e. a live session) —
> it lets the request through so the SPA can bootstrap. It only redirects on a
> genuine first visit with no session cookie. Gating only `/api` is still the
> correct wiring.

**In-cluster service discovery (optional).** Apps running in the same Kubernetes
cluster can route the server-to-server calls (token exchange and JWKS fetch)
through the `homectl-auth` ClusterIP Service instead of the public ingress by
setting `internalAuthServiceUrl`:

```typescript
const { authMiddleware, callbackHandler, logoutHandler } = createAuthClient({
  authServiceUrl: 'https://auth.homectl.no',
  internalAuthServiceUrl: 'http://homectl-auth.homectl.svc.cluster.local',
  clientId: 'my-app',
  clientSecret: process.env.MY_APP_CLIENT_SECRET!,
  appBaseUrl: 'https://my-app.homectl.no',
});
```

`authServiceUrl` stays the public URL — it is what the user's browser is
redirected to (`/authorize`, `/logout`) and what the JWT `iss` claim is
verified against, so it must always match the issuer the auth service signs
tokens with. Apps in the `homectl` namespace can shorten the internal URL to
`http://homectl-auth`.

**Sidecar / backend-mediated auth (forward-auth).** For apps that want the
frontend to be entirely auth-agnostic and to keep browser↔auth traffic off the
public ingress, homectl-auth exposes a server-to-server refresh endpoint —
`POST /internal/refresh` (`{ client_id, client_secret, refresh_token }` →
access token + rotated refresh token in the body). It is the machine analogue of
`POST /refresh` (no `Origin`, no cookies) and is meant to be called in-cluster.
See [ADR 0001](docs/adr/0001-forward-auth-sidecar.md) and the sidecar sketch in
[`docs/sidecar/`](docs/sidecar/README.md).

### Migrating existing users into homectl-auth

An app moving onto homectl-auth can seed its existing user accounts up front so
users keep their credentials — no forced password reset. homectl-auth exposes a
server-to-server import endpoint:

`POST /internal/users/import`

```jsonc
{
  "client_id": "my-app",
  "client_secret": "…",            // the app's client secret
  "users": [
    {
      "email": "alice@example.com",  // identity key — users are matched on email
      "username": "alice",
      "passwordHash": "$2b$12$…",    // bcrypt (bcryptjs, cost 12), sent already hashed
      "role": "member"               // optional; app role for the access grant
    }
  ]
}
```

Like `/internal/refresh`, it is authenticated with the app's `client_id` +
`client_secret` (constant-time compared), carries no browser `Origin` and sets
no cookies, and is meant to be reached over the in-cluster ClusterIP Service
(`http://homectl-auth.homectl.svc.cluster.local`), not the public ingress.

Key points:

- **Passwords are sent pre-hashed.** homectl-auth hashes with bcrypt via
  `bcryptjs` at cost 12; send the same and the hash is stored verbatim, so users
  log in with their current password unchanged. Plaintext is never transmitted.
  Any value that isn't a valid bcrypt hash is rejected per-entry.
- **Email is the identity.** Users are de-duplicated on email (the only UNIQUE
  column). `username` is a display handle and may repeat across accounts.
- **Idempotent.** Re-running is safe. A new email creates the user and grants it
  access to the calling app; an email that already exists is left untouched
  (password and `isAdmin` are never overwritten) but is still granted access to
  the calling app — the one-account-many-apps SSO model.
- **`role`** is optional and validated against the app's configured roles; when
  omitted it defaults to the app's lowest-rank role. It sets the `app_access`
  grant for the calling app only.
- **No `isAdmin`.** Imported users are always created non-admin. homectl-auth's
  `isAdmin` is an operator-level, service-wide flag (access to the admin GUI that
  manages every user and app), not an app-scoped role, so a consuming app cannot
  set it. Express an app's own "admin" concept with the per-app `role` above
  (e.g. `"role": "admin"`); any `isAdmin` sent in the payload is ignored.
- **Best-effort batch.** Once the client is authenticated the call returns `200`
  with a `summary` and a per-entry `results` array (`created` / `skipped` /
  `invalid`), so a bad entry never fails the whole import.

Because the ingress caps request bodies at 1 MB, large imports are another
reason to call this in-cluster (via the Service) rather than through
`auth.homectl.no`; chunk very large user sets into multiple requests.

### 5. Browser helper

```typescript
import { createAuthBrowserClient } from '@gagnatdev/homectl-auth-client/browser';

const auth = createAuthBrowserClient({ authServiceUrl: 'https://auth.homectl.no' });

// Call once on app load — seeds the in-memory access token from the refresh cookie
const token = await auth.bootstrap();
if (!token) { /* redirect to login or show guest UI */ }

// Use for all authenticated API calls
const res = await auth.authedFetch('/api/data');
```

---

## Kubernetes Deployment

CI/CD (`push` to `main`) handles everything: build and push the image, substitute the image tag in `deployment.yaml`, and apply all manifests under `k8s/`. The `homectl` namespace is managed by `homectl-infra` and must exist before the first deploy.

### First-time bootstrap

The deployment uses three Kubernetes Secrets:

**`auth-terraform-secrets`** — created automatically by `terraform apply` in `homectl-infra`. Contains `DATABASE_URL` pointing at the dedicated `auth` database user. No manual step needed.

**`auth-client-secrets`** — created automatically by `terraform apply` in `homectl-infra`, generated from the registered apps and config. Holds the plaintext client secret for each `auth = true` app (the same value Terraform writes to that app's own `AUTH_CLIENT_SECRET`), one entry per registered app; each key matches the app's `clientSecretEnv` in `apps.json` (e.g. `WORKBENCH_CLIENT_SECRET`) and is consumed via `envFrom`. No manual step needed. `apps.json` must be rolled out *after* `terraform apply` creates the corresponding key, or the auth pod crashloops on the missing env var; a key change also needs `kubectl rollout restart deploy/auth` since Secret-backed env vars don't hot-reload.

**`auth-secrets`** — hand-managed. Create once with your own values:

```bash
kubectl create secret generic auth-secrets \
  --namespace homectl \
  --from-literal=RS256_PRIVATE_KEY_PEM="$(base64 -w0 < private_key.pem)" \
  --from-literal=RS256_PUBLIC_KEY_PEM="$(base64 -w0 < public_key.pem)" \
  --from-literal=GITHUB_ADMIN_CLIENT_ID='...' \
  --from-literal=GITHUB_ADMIN_CLIENT_SECRET='...' \
  --from-literal=GITHUB_ADMIN_USER_IDS='...'
```

Once the secret is created, store `private_key.pem` in a secure offline location (password manager or encrypted vault) and delete it from disk. You only need it again if you rotate the key pair. `public_key.pem` is less sensitive — consuming apps should fetch the public key dynamically via `/.well-known/jwks.json` rather than storing it.

Subsequent deploys are fully automated — just push to `main`.

#### Migration: reassign table ownership (one-time, before first deploy with per-app user)

Before the first deploy that switches to `auth-terraform-secrets`, transfer ownership of all existing database objects from the shared admin user to the `auth` user. Connect to the `auth` database as the `homectl` admin user and run:

```sql
REASSIGN OWNED BY homectl TO auth;
```

This transfers ownership of all tables, sequences, and other objects in a single statement. Without this step, schema migrations will fail with *"must be owner of table"*.

### Required secrets (in cluster)

| Secret | Key | Description |
|---|---|---|
| `auth-terraform-secrets` | `DATABASE_URL` | PostgreSQL connection string — managed by Terraform |
| `auth-secrets` | `RS256_PRIVATE_KEY_PEM` | Base64-encoded RS256 private key PEM (PKCS#8) — used to sign JWTs |
| `auth-secrets` | `RS256_PUBLIC_KEY_PEM` | Base64-encoded RS256 public key PEM (SPKI) — used to derive JWKS `kid` and serve `/.well-known/jwks.json` |
| `auth-client-secrets` | `<APP>_CLIENT_SECRET` | plaintext client secret for each app — managed by Terraform |

### Required GitHub Actions secrets

| Secret | Description |
|---|---|
| `SCW_ACCESS_KEY` | Scaleway IAM access key |
| `SCW_SECRET_KEY` | Scaleway IAM secret key (for registry push) |
| `SCW_ORGANIZATION_ID` | Scaleway organization ID |
| `SCW_PROJECT_ID` | Scaleway project ID |
| `K8S_CLUSTER_ID` | Scaleway Kubernetes cluster ID (kubeconfig is fetched at deploy time) |

---

## License

Private — all rights reserved.
