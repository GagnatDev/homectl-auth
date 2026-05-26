# PRD: homectl-auth — Centralized Authentication Service

## Problem Statement

Apps hosted under `homectl.no` each implement their own authentication independently. This means duplicated auth logic, duplicated user databases, and no single-sign-on experience — a user invited to two apps must maintain separate credentials for each. There is no central place to manage who has access to what, and adding a new trusted user to multiple apps requires manual work across multiple codebases and databases.

## Solution

A centralized authentication service at `auth.homectl.no` that issues signed JWTs to all apps on the domain. Users have one account and one set of credentials. The service handles login, session management, invites, and password resets. An admin GUI lets the operator (owner) view all users, manage their app access, and generate invite/reset links. Existing apps integrate via a shared private npm package (`@gagnatdev/homectl-auth-client`) and migrate gradually.

## User Stories

### End User (trusted circle member)

1. As an end user, I want to log in once at `auth.homectl.no` and be redirected back to the app I came from, so that I don't need to log in separately to each app.
2. As an end user, I want to use a username and password to authenticate, so that I don't need a third-party social account.
3. As an end user, I want my session to persist across browser restarts without re-entering my password, so that I'm not constantly interrupted.
4. As an end user, I want my access token to be silently refreshed in the background, so that my session doesn't expire mid-use.
5. As an end user, I want to receive an invite link via Slack or Messenger that lets me set my own password and activate my account, so that I can get started without needing to coordinate a password with the admin.
6. As an end user, I want to be able to ask the admin to reset my password if I forget it, so that I can regain access without losing my account.
7. As an end user, I want logging out of one app to not force me to re-enter my password when visiting another app (until my session expires), so that the experience feels cohesive.

### Admin (operator)

8. As an admin, I want to see a list of all registered users across all apps, so that I have a complete view of who has access to my platform.
9. As an admin, I want to see which apps each user has access to and what role they hold in each, so that I can audit access at a glance.
10. As an admin, I want to grant a user access to an app and assign them a role, so that I can onboard a user to a new app without touching that app's codebase or database.
11. As an admin, I want to revoke a user's access to a specific app, so that I can remove access without deleting their account entirely.
12. As an admin, I want to generate an invite link for a new user with a pre-assigned email and app access, so that I can onboard new users via a manual channel (Slack, Messenger).
13. As an admin, I want invite links to expire after a short time, so that stale links cannot be used to create unauthorized accounts.
14. As an admin, I want to generate a password reset link for any user, so that I can help them recover access without requiring email infrastructure.
15. As an admin, I want to see when a user last authenticated, so that I can identify inactive accounts.
16. As an admin, I want to log in to the admin panel using my regular account credentials, so that I don't need a separate set of admin credentials to manage.
17. As an admin, I want the admin panel to be inaccessible to non-admin users, so that user data is never exposed to regular users.

### App Developer (integrating an app)

18. As an app developer, I want to install a single npm package to integrate centralized auth into my Express app, so that I don't need to reimplement the auth flow from scratch.
19. As an app developer, I want unauthenticated requests to be automatically redirected to the central login page, so that I don't have to write redirect logic myself.
20. As an app developer, I want the authenticated user's identity and app-specific role to be available on `req.user`, so that I can use it for authorization without additional lookups.
21. As an app developer, I want the client package to validate JWTs locally using a cached public key, so that every request doesn't require a network call to the auth service.
22. As an app developer, I want the client package to handle the authorization code callback exchange automatically, so that I only need to register a single callback route.
23. As an app developer, I want the public key to be fetched automatically from the JWKS endpoint, so that key rotation doesn't require me to redeploy my app.
24. As an app developer, I want the package to be available as a scoped private package on GitHub Packages, so that I can install it via npm without publishing to a public registry.
25. As an app developer, I want to be able to migrate my existing app to centralized auth without disrupting users still on the old auth system, so that I can cut over gradually.

## Implementation Decisions

### Modules

#### 1. Auth Service (`homectl-auth` — Express + TypeScript)

The central service deployed at `auth.homectl.no`. Composed of the following internal modules:

**Token Module**
- Issues RS256-signed JWTs containing `{ userId, email, isAdmin, apps: [{ appId, role }] }`
- Access token TTL: 15 minutes
- Exposes `GET /.well-known/jwks.json` — public key set for consumer verification
- Private key stored as a Kubernetes Secret, loaded from env at startup

**Session Module**
- Issues opaque refresh tokens (32 random bytes, hex-encoded)
- Stores SHA256 hash of refresh token in Postgres (never the raw token)
- Refresh token TTL: 30 days, enforced by `expires_at` column
- Refresh token delivered as `HttpOnly; Secure; SameSite=Strict` cookie, path `/`, domain `auth.homectl.no`
- On refresh: validates hash, rotates token (new token issued, old invalidated atomically)
- On logout: deletes session row

**Authorization Code Module**
- Issues short-lived (5 minute) single-use opaque codes for the login redirect flow
- Stores SHA256 hash of code in Postgres with `redirect_uri`, `app_id`, `user_id`
- Code exchange: validates hash, checks expiry and redirect_uri match, deletes code, returns access token

**User Module**
- User record: `id`, `email` (unique), `username`, `password_hash` (bcrypt cost 12), `is_admin`, `created_at`, `last_login_at`
- Password comparison and hashing
- No email sending; email stored for uniqueness only

**App Access Module**
- Table: `(user_id, app_id, role)` — composite primary key
- App definitions loaded from static config file (YAML/JSON, version-controlled)
- Config shape: `{ id, name, allowedRedirectUris: string[] }`
- Designed so app definitions can later be moved to a DB table without changing the access module's interface

**Invite Module**
- Admin creates invite: specifies email, username, app access grants
- Generates signed short-lived token (24h TTL), stores hash in Postgres
- Invite link: `auth.homectl.no/invite?token=...`
- On redemption: user sets password, account activated, app access rows created

**Password Reset Module**
- Admin generates reset link for any existing user
- Same mechanism as invite: short-lived token (24h), hash stored in Postgres
- Link: `auth.homectl.no/reset-password?token=...`
- On redemption: user sets new password, all existing sessions invalidated

**Admin API**
- All routes require `isAdmin: true` in JWT
- Endpoints: list users, get user detail (with app access), grant/revoke app access, create invite, create password reset token

#### 2. Admin GUI (server-rendered HTML + HTMX)

- Rendered by the same Express process — no separate frontend build
- Templating engine: EJS or similar
- HTMX for inline interactions (toggle app access, revoke session) without page reloads
- Protected by admin middleware — any non-admin request redirects to login
- Views: user list, user detail + access editor, invite generator, password reset generator
- Minimal styling — functional over polished

#### 3. Database Schema (Postgres)

Tables in a dedicated `homectl_auth` schema:
- `users` — identity and credentials
- `sessions` — refresh token hashes with expiry and TTL index
- `app_access` — `(user_id, app_id, role)` authorization table
- `invite_tokens` — hashed invite tokens with expiry, pre-assigned email + app grants
- `authorization_codes` — hashed short-lived codes for login redirect flow
- `password_reset_tokens` — hashed reset tokens with expiry

#### 4. `@gagnatdev/homectl-auth-client` (npm package, GitHub Packages)

A small Express middleware package. Public interface:

- `createAuthClient(options)` — factory, configures JWKS URL, auth service base URL, app ID, callback path
- `authMiddleware` — Express middleware; validates Bearer JWT from Authorization header or attached cookie; populates `req.user`; redirects unauthenticated browser requests to `auth.homectl.no/login`
- `callbackHandler` — Express route handler for `/auth/callback`; exchanges authorization code for access token; stores access token in memory; sets up silent refresh
- JWKS fetching: uses `jwks-rsa` library; caches public key; handles key rotation transparently
- Silent refresh: on 401 from any app API call, POSTs to `auth.homectl.no/refresh` with credentials (refresh cookie auto-sent by browser); retries original request

#### 5. Kubernetes Deployment

- Standard k8s manifest (Deployment + Service + Ingress) matching existing app pattern
- TLS via cert-manager + Let's Encrypt on `auth.homectl.no`
- Kubernetes Secrets: Postgres connection string, RS256 private key PEM, JWT signing key ID
- GitHub Actions CI/CD: build → push to Scaleway registry → `kubectl apply`

### Login Flow (Authorization Code)

```
1. User hits protected route on app1.homectl.no (unauthenticated)
2. authMiddleware redirects → auth.homectl.no/login?app_id=app1&redirect_uri=https://app1.homectl.no/auth/callback
3. User submits username + password
4. Auth service validates credentials, checks app access
5. Auth service generates authorization code, stores hash
6. Auth service redirects → app1.homectl.no/auth/callback?code=<code>
7. callbackHandler (server-side) POSTs code + redirect_uri to auth.homectl.no/token
8. Auth service validates code, returns { accessToken }
9. App stores accessToken in memory; refresh cookie already set on auth.homectl.no
10. Subsequent requests: Bearer <accessToken> in Authorization header
11. On 401: POST auth.homectl.no/refresh (credentials: include) → new accessToken
```

### JWT Payload Shape

```json
{
  "sub": "<userId>",
  "email": "user@example.com",
  "isAdmin": false,
  "apps": [
    { "appId": "travel-journal", "role": "member" }
  ],
  "iat": 1234567890,
  "exp": 1234568790
}
```

### Key Distribution

- Private key: RSA 2048-bit, stored in Kubernetes Secret, loaded at startup
- Public key: exposed at `auth.homectl.no/.well-known/jwks.json` (standard JWKS format)
- `homectl-auth-client` fetches JWKS on first request, caches in memory, re-fetches on unknown `kid`

## Testing Decisions

**What makes a good test:** Tests verify observable external behavior — HTTP responses, database state, emitted tokens — not internal implementation details. Tests should be runnable without a live external service (mock Postgres in unit tests, real test DB in integration tests).

**Modules to test:**

- **Token Module** — unit tests: sign a token, verify it decodes correctly, verify wrong algorithm is rejected, verify expired token is rejected
- **Session Module** — integration tests: create session, refresh rotates token, old token rejected after rotation, expired session rejected
- **Authorization Code Module** — integration tests: code exchange succeeds once, second exchange rejected, expired code rejected, mismatched redirect_uri rejected
- **Invite Module** — integration tests: valid invite creates user + app access, expired invite rejected, reused invite rejected
- **Auth endpoints** — integration tests against a test Postgres instance, covering the full login → refresh → logout cycle; mirrors the pattern in `travel-journal/packages/server`
- **`homectl-auth-client`** — unit tests: valid JWT passes middleware, expired JWT triggers refresh, missing token redirects browser requests, `req.user` is populated correctly; mock JWKS server for key fetching tests

**Prior art:** `travel-journal/packages/server` — integration test patterns with Vitest + supertest against a test database.

## Out of Scope

- Email sending of any kind (invite and reset links are sent manually)
- Social/OAuth login (Google, GitHub, etc.)
- Self-service registration (invite-only)
- Multi-factor authentication
- OIDC compliance (this is a bespoke implementation inspired by OAuth2 patterns, not a standards-compliant IdP)
- Dynamic app registration UI (static config for now; DB-backed registration is a future task)
- Native mobile app support
- Organization/team concepts beyond simple per-app roles
- Audit logging beyond `last_login_at`

## Further Notes

- The service is intentionally simple and tailored to a single-operator homelab domain. It is not designed to scale to thousands of users or to be a general-purpose IdP.
- The `homectl-auth-client` package should be versioned with semver. Breaking changes to the JWT payload shape or the callback flow must be considered a major version bump.
- When migrating an existing app (e.g. travel-journal), the old per-app auth and the new centralized auth can coexist during transition. The old `/api/v1/auth` routes can be removed once all users have been migrated and the new flow is verified in production.
- The RS256 private key should be rotated periodically. The JWKS endpoint supports multiple keys via `kid` (key ID), enabling zero-downtime rotation: add the new key to the JWKS response before switching signing to it, then remove the old key after existing tokens have expired (15 minutes).
- App config (static file) should include a human-readable `name` field used in the admin GUI and on the login page ("You are logging in to **Travel Journal**").
