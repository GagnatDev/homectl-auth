# homectl-auth

Centralized authentication service for the `homectl.no` domain. Deployed at `auth.homectl.no`.

Issues RS256-signed JWTs to all apps on the domain. Users have one account and one set of credentials. The service handles login, session management, invites, and password resets. An admin GUI lets the operator manage users, app access, and generate invite/reset links.

## Packages

| Package | Description |
|---|---|
| `packages/server` | The auth service — Express + TypeScript + Postgres |
| `packages/client` | `@gagnatdev/homectl-auth-client` — integration library for consuming apps |

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
# Base64-encode for the env var:
base64 -w0 < private_key.pem
```

### Apps config

```bash
cp apps.example.json apps.json
# Edit apps.json to match your app registrations
```

### Run

```bash
pnpm --filter @homectl/server dev
# Server starts at http://localhost:3000
# JWKS: http://localhost:3000/.well-known/jwks.json
# Health: http://localhost:3000/health
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
5. Sets homectl_refresh_<clientId> cookie (HttpOnly, SameSite=Strict, domain=auth.homectl.no)
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

## Integrating a New App

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

```bash
# Generate a random secret
openssl rand -hex 32

# Hash it (bcrypt cost 12)
node -e "require('bcryptjs').hash('YOUR_RANDOM_SECRET', 12).then(console.log)"

# Store the hash as a Kubernetes secret
kubectl create secret generic homectl-auth-secrets \
  --namespace homectl \
  --from-literal=MY_APP_CLIENT_SECRET='$2b$12$...' \
  --dry-run=client -o yaml | kubectl apply -f -
```

Add the env var reference to `k8s/deployment.yaml`.

### 3. Install the client package

```bash
# In your consuming app:
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

app.use(authMiddleware);           // populates req.user on valid JWT
app.get('/auth/callback', callbackHandler);
app.post('/auth/logout', logoutHandler);
```

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

The only manual step is creating the `homectl-auth-secrets` Secret with real values. See `secrets.example.yaml` for the expected keys.

```bash
kubectl create secret generic homectl-auth-secrets \
  --namespace homectl \
  --from-literal=POSTGRES_URL='postgres://user:pass@host:5432/db' \
  --from-literal=RS256_PRIVATE_KEY_PEM="$(base64 -w0 < private_key.pem)" \
  --from-literal=TRAVEL_JOURNAL_CLIENT_SECRET='$2b$12$...'
```

Subsequent deploys are fully automated — just push to `main`.

### Required secrets (in cluster)

| Secret key | Description |
|---|---|
| `POSTGRES_URL` | PostgreSQL connection string |
| `RS256_PRIVATE_KEY_PEM` | Base64-encoded RS256 private key PEM |
| `<APP>_CLIENT_SECRET` | bcrypt hash of each app's client secret |

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
