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

### Privileged App User (e.g. a user with a high-ranked role in an app)

26. As a privileged app user, I want to generate an invite link for a new user and assign them a role lower than my own, so that I can onboard new users to the app without needing admin intervention.
27. As a privileged app user, I want the invite link I generate to be handled by the same central auth service, so that the new user only needs one account regardless of how many apps invite them.
28. As a privileged app user, I want to be prevented from granting a role equal to or higher than my own, so that I cannot escalate another user's privileges beyond my own level.

## Implementation Decisions

### Modules

#### 1. Auth Service (`homectl-auth` — Express + TypeScript)

The central service deployed at `auth.homectl.no`. Composed of the following internal modules:

**Token Module**
- Issues RS256-signed JWTs containing `{ iss, aud, sub, email, isAdmin, apps: [{ appId, role }], iat, exp }`
- `iss` is always `https://auth.homectl.no`; `aud` is the `client_id` of the requesting app — bound at token-issue time
- Access token TTL: 15 minutes
- Exposes `GET /.well-known/jwks.json` — public key set for consumer verification
- Private key stored as a Kubernetes Secret, loaded from env at startup

**Session Module**
- Issues opaque refresh tokens (32 random bytes, hex-encoded)
- Stores SHA256 hash of refresh token in Postgres (never the raw token)
- Refresh token TTL: 30 days, enforced by `expires_at` column
- **Per-app refresh cookies.** Cookie name is `homectl_refresh_<clientId>` so multiple apps can coexist in the same browser without colliding. Each cookie is `HttpOnly; Secure; SameSite=Strict`, path `/`, domain `.homectl.no` (parent domain so app subdomains like `workbench.homectl.no` receive it for same-origin backend proxies). Each session row in Postgres records the `client_id` it was issued for; the access token's `aud` is taken from that `client_id`.
- **Single sign-on across apps** is handled by a separate `homectl_sso` cookie (also `HttpOnly; Secure; SameSite=Strict`, 30-day TTL, domain `auth.homectl.no`) that records the authenticated user ID. When `/authorize?client_id=appN` is hit and the `homectl_sso` cookie is valid, the auth service skips the login form, verifies the user has access to `appN`, mints a new authorization code, and creates a new app-scoped session — no password re-entry required.
- On refresh (`POST /refresh` from app's browser): the auth service reads the per-app cookie matching the `Origin` header (CORS-validated), rotates the refresh token (new issued, old invalidated atomically), returns a new access token with `aud = client_id`.
- On logout (`POST /logout` from app's browser): deletes only the session row for the calling app and clears that app's refresh cookie. Other apps' sessions and the `homectl_sso` cookie are preserved — visiting another app or revisiting this app re-bootstraps without re-login until the SSO cookie expires.
- **"Log out everywhere"** (future, out of scope for v1): would clear `homectl_sso` and all session rows for the user.
- `/refresh` and `/logout` endpoints accept cross-origin requests with credentials from registered app origins (CORS allow-list from app config — `Access-Control-Allow-Credentials: true`, exact-origin echo, no wildcard).

**Authorization Code Module**
- Issues short-lived (5 minute) single-use opaque codes for the login redirect flow
- Stores SHA256 hash of code in Postgres with `redirect_uri`, `client_id`, `user_id`
- Code exchange (`POST /token`) requires:
  - `grant_type=authorization_code`
  - `code` — the authorization code
  - `client_id` — must match the code's bound client
  - `client_secret` — authenticates the calling app (stored as a Kubernetes Secret on the consuming app side; one secret per app)
  - `redirect_uri` — must match the code's bound redirect URI exactly
- On success: validates client credentials, validates code (hash, expiry, redirect_uri match, client_id match), deletes code, returns `{ access_token, token_type, expires_in }`
- The `state` parameter from the authorization request is passed through unchanged in the callback redirect — the client library, not the auth service, verifies it

**User Module**
- User record: `id`, `email` (unique), `username`, `password_hash` (bcrypt cost 12), `is_admin`, `created_at`, `last_login_at`
- Password comparison and hashing
- No email sending; email stored for uniqueness only

**App Access Module**
- Table: `(user_id, app_id, role)` — composite primary key (`app_id` corresponds to the `client_id` used in OAuth-style endpoints)
- App definitions loaded from static config file (YAML/JSON, version-controlled)
- Config shape:
  ```json
  {
    "id": "travel-journal",
    "name": "Travel Journal",
    "clientSecretEnv": "TRAVEL_JOURNAL_CLIENT_SECRET",
    "allowedRedirectUris": ["https://reisedagbok.homectl.no/auth/callback"],
    "allowedOrigins": ["https://reisedagbok.homectl.no"],
    "roles": [
      { "name": "follower", "rank": 1 },
      { "name": "creator", "rank": 2 }
    ]
  }
  ```
- `clientSecretEnv` names an environment variable holding the bcrypt-hashed client secret (the hash is committed to the cluster as a Kubernetes Secret; the raw secret is only known to the consuming app and is distributed once via secure channel during app onboarding)
- `allowedOrigins` is the CORS allow-list for that app's browser-side calls to `/refresh` and `/logout`
- Role ranks are app-defined integers; the auth service treats them as opaque ordinals — no domain meaning is assumed
- Designed so app definitions can later be moved to a DB table without changing the access module's interface

**Invite Module**
- Two invite actors: **admin** (bypasses all rank checks) and **privileged app user** (subject to rank enforcement)
- Admin creates invite via the admin GUI: specifies email, app access grants at any role
- Privileged app user creates invite via the delegated invite API:
  ```
  POST /api/invites
  Authorization: Bearer <JWT of inviting user>
  { "email": "...", "appId": "travel-journal", "role": "follower" }
  ```
  Auth service enforces: `invitee_role.rank < inviter_role.rank` in that app — generic, no domain knowledge required
- If the inviting user has no access grant for the specified `appId`, the request is rejected with 403 (the rank check has no defined value to compare against)
- Both flows generate the same short-lived token (24h TTL), hash stored in Postgres
- Invite link: `auth.homectl.no/invite?token=...`
- On redemption: user sets password, account activated, app access rows created
- If the invited email already has an account, the invite instead adds the app access grant to the existing account (password unchanged, no new user row)
- If the invited email belongs to an account that was created **after** the invite was issued (different user ID than expected), the invite is rejected — protects against a race where a different user claims the email between invite creation and redemption

**Password Reset Module**
- Admin generates reset link for any existing user
- Same mechanism as invite: short-lived token (24h), hash stored in Postgres
- Link: `auth.homectl.no/reset-password?token=...`
- On redemption: user sets new password; all refresh tokens (rows in `sessions`) for that user are deleted, so subsequent `/refresh` calls fail and the user must re-authenticate
- **Limitation:** outstanding access tokens (JWTs) remain valid until their `exp` — up to 15 minutes. Stateless JWTs cannot be revoked without a denylist, which is out of scope. This is acceptable for the threat model (small trusted circle, short TTL)

**Admin API**
- All routes require `isAdmin: true` in JWT
- Endpoints: list users, get user detail (with app access), grant/revoke app access, create invite, create password reset token

**Public Auth Endpoints (summary)**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/authorize` | Authorization request — renders login page bound to `client_id`, `redirect_uri`, `state` |
| `POST` | `/login` | Credential submission; on success, redirects to `redirect_uri` with `code` + `state` |
| `POST` | `/token` | Authorization code exchange (server-to-server, client-authenticated) |
| `POST` | `/refresh` | Browser-side: rotates refresh cookie, returns new access token |
| `POST` | `/logout` | Browser-side: deletes session row, clears refresh cookie |
| `GET` | `/.well-known/jwks.json` | Public key set |
| `GET` | `/invite?token=...` | Invite redemption page (set password, accept grants) |
| `GET` | `/reset-password?token=...` | Password reset page |
| `POST` | `/api/invites` | Delegated invite creation (Bearer JWT required) |

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
- `sessions` — refresh token hashes with expiry and TTL index; column `client_id` records the app the session was issued for (binds `aud` on subsequent refreshes)
- `app_access` — `(user_id, app_id, role)` authorization table
- `invite_tokens` — hashed invite tokens with expiry, pre-assigned email + app grants; column `expected_user_id` (nullable) for invites targeting an existing account, to detect the race described in the Invite Module
- `authorization_codes` — hashed short-lived codes for login redirect flow
- `password_reset_tokens` — hashed reset tokens with expiry

**Expired row cleanup.** Single-use rows (`authorization_codes`, `invite_tokens`, `password_reset_tokens`, expired `sessions`) are deleted on use, but expired-but-unused rows accumulate indefinitely. A scheduled internal job runs every hour and executes `DELETE ... WHERE expires_at < NOW() - interval '1 day'` against each table. The grace day lets short-lived debugging inspect expired rows; for `sessions` it is irrelevant because expired refresh tokens fail validation regardless. The job is implemented as an in-process `setInterval` (single replica is sufficient at this scale; a Kubernetes CronJob is a future option if multi-replica is needed).

#### 4. `@gagnatdev/homectl-auth-client` (npm package, GitHub Packages)

A small package with two entry points — a server-side Express integration and a browser-side helper. The two parts are independent but versioned together.

**Server-side entry point: `@gagnatdev/homectl-auth-client/server`**

- `createAuthClient(options)` — factory. Required options:
  - `authServiceUrl` — the public URL, e.g. `https://auth.homectl.no`; used for browser-facing redirects and as the expected JWT `iss` claim
  - `internalAuthServiceUrl` — optional; base URL for server-to-server calls (token exchange and the default JWKS URL). Set to an in-cluster service-discovery address (e.g. `http://homectl-auth.homectl.svc.cluster.local`) to keep backend traffic off the public ingress. Defaults to `authServiceUrl`. Never used for browser redirects or issuer verification.
  - `jwksUrl` — derived by default as `${internalAuthServiceUrl ?? authServiceUrl}/.well-known/jwks.json`
  - `clientId` — the app's registered identifier (e.g. `"travel-journal"`)
  - `clientSecret` — read from env in the consuming app; sent on token exchange
  - `appBaseUrl` — the public-facing URL of the consuming app (e.g. `https://reisedagbok.homectl.no`); used to construct `redirect_uri` reliably without depending on `req.hostname`
  - `callbackPath` — default `/auth/callback`
- `authMiddleware` — Express middleware. Validates Bearer JWT:
  - Verifies signature via cached JWKS
  - Verifies `iss === authServiceUrl`
  - Verifies `aud === clientId` (rejects tokens issued for a different app)
  - Verifies `exp` is in the future
  - Verifies `apps[]` includes an entry for `clientId` (extracts the role)
  - Populates `req.user = { id, email, isAdmin, role }` (role is the role for this app)
  - On unauthenticated browser requests (HTML accept header): generates a random `state` nonce, stores it in a short-lived signed cookie on the app's domain, redirects to `${authServiceUrl}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${appBaseUrl}${callbackPath}&state=${nonce}`
  - On unauthenticated API requests: returns 401 (browser-side helper will refresh and retry)
- `callbackHandler` — Express route handler for `callbackPath`. Reads `code` and `state` from query; verifies `state` matches the cookie value, deletes the cookie; POSTs to `${internalAuthServiceUrl ?? authServiceUrl}/token` with `{ grant_type, code, client_id, client_secret, redirect_uri }`; on success, redirects the browser back to the originally requested URL (stored in the state cookie payload) or to `appBaseUrl/`. The exchanged access token is discarded — the refresh cookie is now set on `auth.homectl.no`, and the browser will bootstrap an access token via `/refresh` on first page load.
- `logoutHandler` — Express route handler for `/auth/logout`. Renders a page that calls `${authServiceUrl}/logout` from the browser (cookies included), then redirects to `appBaseUrl/`.
- JWKS fetching: uses `jwks-rsa`; caches public keys in memory; re-fetches on unknown `kid` (zero-downtime key rotation).

**Browser-side entry point: `@gagnatdev/homectl-auth-client/browser`**

- `createAuthBrowserClient({ authServiceUrl })` — factory.
- `bootstrap()` — on app load, POSTs to `${authServiceUrl}/refresh` with `credentials: "include"`. On success, stores the returned access token in an in-memory variable. On 401, returns null — caller redirects to login.
- `getAccessToken()` — returns the in-memory token (or null).
- `authedFetch(input, init)` — wrapper around `fetch` that attaches `Authorization: Bearer ${token}`; on 401, calls `bootstrap()` once and retries; on the second 401, surfaces the error.
- `logout()` — POSTs to `${authServiceUrl}/logout` with credentials, clears the in-memory token.

**Access token storage model — explicit decision**

The access token lives in **browser-side JS memory only**. Rationale:
- Mirrors the existing pattern in `travel-journal` — minimizes per-app integration churn
- Avoids server-side session state, sticky sessions, and shared session stores in the consuming app
- The HttpOnly refresh cookie on `auth.homectl.no` (sent cross-origin via `credentials: "include"`) re-bootstraps the access token on page reload, so no token is persisted in browser storage and XSS exposure is bounded to the lifetime of an open tab
- The auth service's `/refresh` and `/logout` endpoints emit `Access-Control-Allow-Origin: <app-origin>` (allow-list from app config) and `Access-Control-Allow-Credentials: true` to permit the cross-origin call

**Hard reload behavior.** A page reload (or new tab to the same app) does **not** prompt for a password. The in-memory access token is lost, but the `homectl_refresh_<clientId>` cookie on `auth.homectl.no` survives — cookies are not affected by reloads. On app startup the browser helper calls `bootstrap()`, which does a single `/refresh` round-trip and seeds a fresh access token. The user sees a brief loading state (typically <100ms) instead of the unauthenticated UI; this requires the consuming app to gate identity-dependent rendering on the bootstrap promise (already the pattern in `travel-journal`'s `AuthContext`). A password prompt only appears when the refresh cookie has expired (30-day TTL), the session row has been deleted (admin password reset, future "log out everywhere"), or the browser has cleared cookies.

This rules out SSR for protected pages in consuming apps. Page rendering that depends on the user's identity must occur after `bootstrap()` resolves on the client. This is consistent with the SPA pattern already in use.

#### 5. Kubernetes Deployment

- Standard k8s manifest (Deployment + Service + Ingress) matching existing app pattern
- TLS via cert-manager + Let's Encrypt on `auth.homectl.no`
- Kubernetes Secrets: Postgres connection string, RS256 private key PEM, JWT signing key ID
- GitHub Actions CI/CD: build → push to Scaleway registry → `kubectl apply`

### Login Flow (Authorization Code)

```
 1. Browser hits protected route on app1.homectl.no (unauthenticated)
 2. authMiddleware generates random `state` nonce, stores it (plus the original request URL)
    in a short-lived signed cookie on app1.homectl.no
 3. authMiddleware redirects browser →
      auth.homectl.no/authorize
        ?response_type=code
        &client_id=app1
        &redirect_uri=https://app1.homectl.no/auth/callback
        &state=<nonce>
 4. Auth service renders login page bound to client_id, validates redirect_uri against
    the app's allowedRedirectUris allow-list
 5. User submits username + password to auth.homectl.no/login
    (skipped on subsequent app logins: if a valid `homectl_sso` cookie is present at
    step 4 and the user has access to `client_id`, jump directly to step 6)
 6. Auth service validates credentials, verifies user has access to the requested client_id,
    sets `homectl_sso` cookie (if not already set) and per-app `homectl_refresh_<client_id>`
    cookie on auth.homectl.no, creates session row bound to `client_id`,
    generates authorization code
 7. Auth service redirects browser →
      app1.homectl.no/auth/callback?code=<code>&state=<nonce>
 8. callbackHandler reads state cookie, verifies the `state` query parameter matches,
    deletes the cookie (single-use, CSRF defense)
 9. callbackHandler POSTs server-to-server to auth.homectl.no/token:
      { grant_type: "authorization_code", code, client_id, client_secret, redirect_uri }
10. Auth service validates client credentials, validates code (hash, expiry, redirect_uri,
    client_id match), deletes code, returns { access_token, token_type, expires_in }
11. callbackHandler discards the access token (its only role here is to confirm the code
    was valid for this client), redirects browser to the original request URL
12. Browser-side helper on page load calls auth.homectl.no/refresh
    (credentials: include — refresh cookie auto-sent), receives new access token,
    stores it in JS memory
13. Subsequent API calls from browser include `Authorization: Bearer <accessToken>`;
    authMiddleware on the app's backend validates the JWT locally
14. On 401: browser helper calls /refresh, retries the original request
```

### Logout Flow

```
 1. User clicks "Log out" in app1
 2. Browser-side helper POSTs to auth.homectl.no/logout (credentials: include)
 3. Auth service deletes the session row, clears the refresh cookie
 4. Browser-side helper clears the in-memory access token
 5. App optionally redirects to a public page

Notes:
- Logout is per-session, which is effectively per-app (sessions are app-scoped, see
  Session Module). Logging out of app1 does not invalidate app2's session — this is
  intentional. To log out of every app at once, a future "log out everywhere"
  endpoint can delete all sessions for the user (out of scope for v1).
- Outstanding access tokens remain valid until expiry (up to 15 minutes). See the
  revocation lag note in Further Notes.
```

### JWT Payload Shape

```json
{
  "iss": "https://auth.homectl.no",
  "aud": "travel-journal",
  "sub": "<userId>",
  "email": "user@example.com",
  "isAdmin": false,
  "apps": [
    { "appId": "travel-journal", "role": "creator" }
  ],
  "iat": 1234567890,
  "exp": 1234568790
}
```

- `iss` — the auth service base URL; verified by every consumer
- `aud` — the `client_id` the token was issued for; consumers must reject any token whose `aud` does not equal their own configured `clientId`
- `apps` — every app the user has access to. App A's token reveals the user also belongs to App B. **Accepted trade-off:** for a small trusted-circle homelab, the simplicity of one token per session outweighs the disclosure (the alternative — per-app token exchange, narrowed claims — adds round trips and complexity for no real-world gain at this scale). Consumers MUST still enforce `aud` to prevent token substitution; the `apps` array is informational/authorization-only.

### Key Distribution

- Private key: RSA 2048-bit, stored in Kubernetes Secret, loaded at startup
- Public key: exposed at `auth.homectl.no/.well-known/jwks.json` (standard JWKS format)
- `homectl-auth-client` fetches JWKS on first request, caches in memory, re-fetches on unknown `kid`

## Testing Decisions

**What makes a good test:** Tests verify observable external behavior — HTTP responses, database state, emitted tokens — not internal implementation details. Tests should be runnable without a live external service (mock Postgres in unit tests, real test DB in integration tests).

**Modules to test:**

- **Token Module** — unit tests: sign a token, verify it decodes correctly with `iss` and `aud` populated, verify wrong algorithm is rejected, verify expired token is rejected, verify token with wrong `aud` is rejected by consumer validation, verify token with wrong `iss` is rejected
- **Session Module** — integration tests: create session, refresh rotates token, old token rejected after rotation, expired session rejected, per-app refresh cookies isolate (logout from app1 leaves app2's session valid), SSO short-circuit at `/authorize` (valid `homectl_sso` cookie skips login form)
- **Authorization Code Module** — integration tests: code exchange succeeds once, second exchange rejected, expired code rejected, mismatched redirect_uri rejected, missing `client_secret` rejected (401), wrong `client_secret` rejected (401), mismatched `client_id` rejected
- **State / CSRF on callback** — integration tests at the client-package level: missing `state` cookie rejects callback, mismatched `state` rejects callback, state cookie is single-use (cleared on use)
- **Invite Module** — integration tests: valid admin invite creates user + app access, valid delegated invite respects rank ceiling (invitee rank < inviter rank), invite at equal or higher rank rejected, delegated invite where inviter has no role in target app rejected (403), expired invite rejected, reused invite rejected, invite to existing account adds app access without creating duplicate user, invite redemption rejected if email belongs to a different (newer) user than expected
- **Password Reset Module** — integration tests: reset deletes all sessions for the user, outstanding JWTs are NOT invalidated (documented behavior), reused/expired reset tokens rejected
- **Auth endpoints** — integration tests against a test Postgres instance, covering the full authorize → login → callback → refresh → logout cycle including state round-trip and per-app refresh cookie semantics; mirrors the pattern in `travel-journal/packages/server`
- **CORS** — integration tests: `/refresh` and `/logout` accept requests with credentials from origins in app config, reject requests from unknown origins
- **Expired row cleanup** — unit test: cleanup query selects only rows with `expires_at < NOW() - interval '1 day'`; integration: cleanup deletes the expected rows and leaves fresh ones alone
- **`homectl-auth-client` (server)** — unit tests: valid JWT passes middleware, JWT with wrong `aud` rejected, JWT with wrong `iss` rejected, expired JWT returns 401 on API request and triggers redirect on browser request, missing token redirects browser requests with `state` cookie set, `req.user` is populated correctly with `role` for the configured `clientId`; mock JWKS server for key fetching tests
- **`homectl-auth-client` (browser)** — unit tests: `bootstrap()` stores token on success, returns null on 401, `authedFetch` retries once on 401 then surfaces error, `logout()` clears local token

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
- **Access revocation lag.** Revoking a user's app access (or admin status) via the admin panel takes effect within one access token TTL — up to 15 minutes — because outstanding JWTs cannot be invalidated. The user remains effective until their current token expires; the next `/refresh` will fail to mint a new token for the revoked app. A token denylist would close this gap but is out of scope.
- **OAuth2 alignment.** The flow uses standard OAuth2 names (`response_type=code`, `client_id`, `client_secret`, `state`, `grant_type=authorization_code`) and standard JWT claims (`iss`, `aud`, `sub`, `iat`, `exp`) so that future migration to a standards-compliant IdP would be mechanical rather than a redesign. The deliberate deviations from OAuth 2.1 / OIDC are: no PKCE (covered by client authentication), no separate ID token (one JWT carries both identity and authorization claims), no `/.well-known/openid-configuration` discovery (apps configure URLs statically), no `scope=openid` (replaced by the `apps` array). These are acceptable for a bespoke single-operator service.
