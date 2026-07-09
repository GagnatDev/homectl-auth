# PRD: `homectl-auth-proxy` — Forward-Auth Sidecar

- **Status:** Proposed (not yet implemented)
- **Author:** homectl-auth maintainers
- **Date:** 2026-07-07
- **Related:** [ADR 0001 — Forward-auth sidecar](./adr/0001-forward-auth-sidecar.md),
  sidecar sketch in [`docs/sidecar/`](./sidecar/README.md), main
  [PRD](./prd.md)

> This document is written so an implementing agent (or engineer) can build the
> sidecar from scratch without prior context. It explains **why** the component
> exists, **what** to build, and the **documentation** that must ship with it.
> It deliberately restates background that lives elsewhere so it can be read
> standalone.

---

## Background

`homectl-auth` is the centralized auth service for the `homectl.no` domain
(`auth.homectl.no`). It issues RS256-signed JWTs, runs the authorization-code
login flow, and manages opaque rotating refresh tokens stored server-side in
Postgres. Today apps integrate with it through the `@gagnatdev/homectl-auth-client`
npm package, which has two halves:

- **Server** (`packages/client/src/server.ts`): `authMiddleware` verifies the
  bearer JWT and populates `req.user`; `callbackHandler` runs the code
  exchange; `logoutHandler` renders a logout page.
- **Browser** (`packages/client/src/browser.ts`): `bootstrap()` fetches an
  access token from `auth.homectl.no/refresh` into JS memory; `authedFetch`
  attaches it as `Authorization: Bearer <jwt>` and re-bootstraps on `401`.

This model has proven error-prone and costly in three concrete ways:

1. **The frontend is not auth-agnostic.** Every SPA must know the auth service
   URL, call `bootstrap()` on load, use `authedFetch`, and implement its own
   redirect-to-login. This is re-implemented per app and is easy to get wrong.

2. **A recurring class of bugs.** Because a browser never attaches a `Bearer`
   header to a top-level *navigation* (the access token lives only in JS memory
   and is fetched by `bootstrap()` *after* the shell loads), any app that gates
   an HTML route with the bearer-based `authMiddleware` bounces every page load
   to `/authorize` and loops back to the login screen. This forced a revert in
   the `workbench` app. A second, subtler variant also bit `workbench`: a
   backend that proxies the browser's refresh call to `auth.homectl.no/refresh`
   must send an `Origin` header, because `/refresh` resolves the calling app
   **from `Origin`** — a server-to-server proxy that forwards only cookies gets
   `400 unknown_origin` and loops. Both are symptoms of the same root problem:
   auth is split across two channels (cookie+redirect for HTML, bearer-in-memory
   for API) and each app author must wire them together correctly.

3. **Ingress/egress cost.** Server-to-server calls (token exchange, JWKS) can
   already be routed in-cluster via `internalAuthServiceUrl`, but the browser's
   `POST /refresh` still hits the **public ingress** on every page load and
   every token expiry. In a cost-sensitive cluster this is the recurring charge
   we want to eliminate.

### What already exists (do not rebuild)

- **`POST /internal/refresh`** (`packages/server/src/routes/internal.router.ts`)
  — the server-to-server counterpart of `POST /refresh`. It authenticates with
  `client_id` + `client_secret` (bcrypt, same trust as `/token`), rotates the
  refresh token, and returns the access token **and the rotated refresh token
  in the JSON body** (no `Origin`, no `Set-Cookie`). This is the building block
  the sidecar refreshes against. **Already merged.**
- **Client-library guardrail + README fix** — `authMiddleware` no longer
  redirects an HTML request to `/authorize` when the app's refresh cookie is
  present, and the README now shows `app.use('/api', authMiddleware)` with an
  unauthenticated shell route. Mitigates bug (2) for library users but does not
  make the frontend auth-agnostic. **Already merged.**
- A **reference sketch** of the proxy in [`docs/sidecar/README.md`](./sidecar/README.md)
  and an example Deployment in [`docs/sidecar/deployment.example.yaml`](./sidecar/deployment.example.yaml).
  These are illustrative, not production code.

---

## Problem Statement

Apps need a way to integrate with `homectl-auth` in which the **frontend is
completely unaware** of the auth service (it makes only same-origin requests and
holds no token), and the **backend/infrastructure owns all token handling** —
login redirects, code exchange, refresh, logout, and JWT verification — with
that traffic staying **in-cluster** wherever possible. The current library-based
approach cannot deliver this without each app re-implementing a backend gateway,
which is exactly where the bugs keep appearing.

## Solution

Ship a small, standalone **forward-auth sidecar** — `homectl-auth-proxy` — that
runs as a second container inside each consuming app's pod. Ingress routes the
app's hostname to the **sidecar**, which authenticates the browser session with
its own opaque cookie, runs the OAuth flow, refreshes tokens in-cluster against
`/internal/refresh`, and proxies each request to the app container with a
**verified identity injected as request headers**.

```
Browser ──HTTPS──▶ Ingress ──▶ [ pod:  sidecar :4180  ──▶  app :3000 ]
                                          │
                                          └── in-cluster ──▶ homectl-auth ClusterIP
                                                /authorize        (browser 302, PUBLIC url)
                                                /token            (code exchange)
                                                /internal/refresh (token refresh)
                                                /.well-known/jwks.json
```

The browser holds only the sidecar's session cookie. The app backend reads a
trusted header (`Authorization: Bearer <jwt>` and/or `X-Homectl-*`) and does no
auth work. The frontend is entirely auth-agnostic. This is the standard BFF /
forward-auth pattern (cf. `oauth2-proxy`, Envoy `ext_authz`, Pomerium),
specialized to homectl-auth's endpoints and cookie/claims contract.

## Goals

- Frontends hold no token and make only same-origin requests; no auth SDK in the
  browser.
- App backends receive identity via a trusted, verified header; zero auth logic
  required in app code.
- Browser↔auth traffic on the public ingress is reduced to the interactive login
  redirect only. Refresh and token exchange are in-cluster.
- Multi-pod safe **without** a distributed session store in the common case.
- Language-agnostic: works for any app that can read an HTTP header, not just
  Node/Express.
- **Fully backwards compatible**: the existing client-library integration keeps
  working unchanged; adopting the sidecar is opt-in per app.

## Non-Goals

- Replacing `@gagnatdev/homectl-auth-client`. Both remain supported.
- Changing homectl-auth's public endpoints, cookies, or JWT claims (beyond the
  already-merged additive `/internal/refresh`).
- Introducing Redis or any shared session store as a hard dependency (see
  "Session model").
- Implementing per-route authorization/RBAC inside the proxy. The proxy
  authenticates and injects identity + role claims; the app enforces
  authorization.

---

## User Stories

### App Developer (adopting the sidecar)

1. As an app developer, I want to add one sidecar container and point ingress at
   it, so that my app gets authentication without any auth code in my frontend
   or backend.
2. As an app developer, I want the authenticated user's id, email, and app role
   available on an incoming request header, so that I can authorize requests
   without calling the auth service.
3. As an app developer, I want my SPA to make plain same-origin `fetch` calls
   with no token handling, so that the frontend has zero knowledge of
   homectl-auth.
4. As an app developer, I want unauthenticated page loads to be redirected to
   central login automatically by the sidecar, so that I don't implement
   redirect logic.
5. As an app developer, I want a clear, copy-pasteable integration guide
   (config, k8s manifests, local dev), so that I can adopt the sidecar in an
   afternoon.
6. As an app developer, I want to trust the injected identity header safely, so
   that a malicious client cannot forge identity by sending that header to the
   ingress.
7. As an app developer, I want to run my app locally without a full cluster, so
   that day-to-day development isn't blocked on the sidecar.

### Operator

8. As an operator, I want the sidecar to be stateless so I can scale app pods
   horizontally without deploying Redis.
9. As an operator, I want `homectl-auth`↔sidecar traffic to stay in-cluster, so
   that I minimize ingress/egress cost.
10. As an operator, I want the sidecar image built and pushed by CI to the same
    registry as the auth service, so that releases are consistent and versioned.
11. As an operator, I want a health/readiness endpoint on the sidecar, so that
    Kubernetes can gate traffic correctly.

### End User

12. As an end user, I want login and silent refresh to behave exactly as before
    (SSO across apps, session persistence), so that adopting the sidecar is
    invisible to me.

---

## Architecture & Flows

### Request lifecycle (per incoming request)

1. **Read session.** Decrypt the sidecar's session cookie (`hs_session`). If
   absent/invalid → treat as unauthenticated.
2. **Unauthenticated:**
   - HTML navigation (`Accept: text/html`) → begin the authorization-code flow:
     set a signed, single-use `state` cookie and 302 the browser to the
     **public** `${PUBLIC_AUTH_URL}/authorize` with `client_id`, `redirect_uri`,
     `state`, and a `return_to`.
   - Non-HTML (XHR/API) → respond `401` (let the SPA handle it); do **not**
     redirect an XHR.
3. **Callback** (`GET <callbackPath>`): verify the `state` cookie (CSRF), clear
   it, exchange `code` at `${INTERNAL_AUTH_URL}/token`, obtain the initial
   refresh token (see "First refresh token"), write the encrypted session
   cookie, and 302 to the sanitized `return_to`.
4. **Authenticated:** if the cached access token is within `REFRESH_SKEW`
   seconds of expiry, call `${INTERNAL_AUTH_URL}/internal/refresh` with
   `{ client_id, client_secret, refresh_token }`, verify the returned JWT
   against JWKS, and re-write the session cookie with the **rotated** refresh
   token.
5. **Inject & proxy:** strip any inbound `Authorization` and `X-Homectl-*`
   headers, then inject `Authorization: Bearer <jwt>` and `X-Homectl-User` /
   `X-Homectl-Email` / `X-Homectl-Role`, and proxy to `UPSTREAM`.
6. **Logout** (`POST <logoutPath>`): call `${INTERNAL_AUTH_URL}` logout as
   appropriate, delete the session cookie, redirect/return.

### First refresh token

The sidecar needs to hold a refresh token to drive `/internal/refresh`. Two
approaches, both acceptable; the implementer should pick one and document it:

- **Reuse today's cookie (lowest change).** `homectl-auth` already sets
  `homectl_refresh_<clientId>` on `Domain=.homectl.no` during `/login`, so it
  reaches the app host. The sidecar reads it once after the code exchange, then
  owns rotation via `/internal/refresh`.
- **Return it from exchange (cleaner end-state).** Add a server-to-server code
  exchange variant to homectl-auth that returns the refresh token in the JSON
  body, so the browser never receives a refresh cookie at all. This is a small
  additive follow-up to the auth service and is the preferred long-term design.

### Session model (multi-pod) — why no Redis

The durable session already lives centrally in homectl-auth's `sessions` table;
the sidecar only needs a valid access token per request. Run the sidecar
**stateless** with an **encrypted-cookie session**:

- Refresh token (and optionally the cached access token) live in an AES-256-GCM
  encrypted, HttpOnly cookie.
- All replicas share **one** symmetric cookie key from a Kubernetes Secret, so
  any request can land on any pod. No Redis, no sticky sessions.
- Access-token verification is stateless JWKS; each pod caches the key set.

**Known hazard — refresh-token rotation races.** `rotateSession` deletes the old
token and issues a new one on every refresh, so two concurrent refreshes for the
same session (different pods or multiple browser tabs) race; one wins, the other
token dies. Mitigations, cheapest first:

1. Cache the access token in the cookie so refreshes are rare (~once per 15 min),
   shrinking the window.
2. **Recommended follow-up in homectl-auth:** a short **rotation grace window**
   — accept the immediately-previous refresh token for ~10–30s after rotation.
   Also fixes multi-tab races for the existing cookie-based `/refresh`.
3. Only if contention persists: a small shared lock (Redis). This is the *only*
   thing that would introduce a distributed store, and should be deferred until
   measured.

---

## Implementation Decisions

### Location & packaging

- New workspace package **`packages/proxy`**, name **`@homectl/proxy`**,
  `private: true` — **not** published to npm. It is a deployable service like
  `@homectl/server`, not a library like the client.
- It ships as the Docker image **`homectl-auth-proxy`** (registry
  `rg.fr-par.scw.cloud/homectl/homectl-auth-proxy`, matching the auth service's
  registry).
- It **may** depend on `@gagnatdev/homectl-auth-client` for JWT/JWKS
  verification so verification logic never drifts from what library apps use;
  otherwise use `jose` directly. The implementer should prefer reuse.
- Rationale for in-repo co-location vs a separate repo: the proxy is tightly
  coupled to homectl-auth's `/internal/refresh` shape, the
  `homectl_refresh_<clientId>` cookie name, the RS256 claims, and the issuer.
  Co-locating means those change in lockstep in one PR under shared
  tooling/CI. Apps consume the image by tag, so release cadence stays
  independent.

### Build & CI

- Add **`Dockerfile.proxy`** at the repo root, mirroring the existing multi-stage
  `Dockerfile` pattern (pnpm, `--filter @homectl/proxy build`, prune prod deps,
  non-root user). `EXPOSE 4180`.
- Add a **build+push job** for the `homectl-auth-proxy` image. It must **only
  build and push** — it must **not** `kubectl apply` the proxy, because the
  proxy runs as a sidecar in *consuming app* pods, not in the `homectl`
  namespace deployment. Deployment happens in each app's own repo/manifests.
- `pnpm -r typecheck` and `pnpm -r test` must cover the new package.

### Configuration (environment variables)

| Var | Required | Example | Purpose |
|---|---|---|---|
| `PUBLIC_AUTH_URL` | yes | `https://auth.homectl.no` | Browser redirect target + JWT `iss` to verify against. |
| `INTERNAL_AUTH_URL` | yes | `http://homectl-auth.homectl` | In-cluster ClusterIP for `/token`, `/internal/refresh`, JWKS. |
| `AUTH_CLIENT_ID` | yes | `workbench` | Registered app id. |
| `AUTH_CLIENT_SECRET` | yes | _(Secret)_ | For `/token` + `/internal/refresh`. |
| `APP_BASE_URL` | yes | `https://workbench.homectl.no` | Public base; builds `redirect_uri`. |
| `UPSTREAM` | yes | `http://127.0.0.1:3000` | The app container in the same pod. |
| `COOKIE_KEY` | yes | _(32-byte base64 Secret)_ | Cookie encryption key. **Identical across all replicas.** |
| `CALLBACK_PATH` | no | `/auth/callback` | Path the sidecar handles for the code exchange. |
| `LOGOUT_PATH` | no | `/auth/logout` | Path the sidecar handles for logout. |
| `LISTEN_PORT` | no | `4180` | Port ingress targets. |
| `REFRESH_SKEW_SECONDS` | no | `60` | Refresh this long before access-token expiry. |
| `SESSION_COOKIE_NAME` | no | `hs_session` | Sidecar session cookie name. |

Config must be validated at startup with a clear fatal error listing any
missing/invalid vars (follow the repo's existing env-validation approach).

### Security requirements (must-haves)

- **Header spoofing defense.** The sidecar MUST delete inbound `Authorization`
  and any `X-Homectl-*` headers before injecting its own. Document loudly that
  the app must be reachable **only** through the sidecar (never expose the app
  container to the ingress directly).
- **`/internal/refresh` exposure.** It is client-secret-authenticated, so public
  reachability is no worse than `/token`; still, recommend restricting `/internal/*`
  to in-cluster traffic via NetworkPolicy and/or an ingress path exclusion
  (defense in depth). Provide the manifest snippet in docs.
- **CSRF on callback.** Verify the signed, single-use `state` cookie on
  callback; reject on mismatch.
- **Cookie flags.** Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`
  (so the post-login top-level redirect carries it), `Path=/`. AES-256-GCM with
  authentication tag; reject tampered cookies.
- **`return_to` sanitization.** Only allow same-origin relative paths as the
  post-login redirect target; never an absolute off-site URL (open-redirect
  guard).
- **No token in the browser.** The JWT stays inside the pod; the browser sees
  only the opaque session cookie.

### Behavioral parity

- Preserve SSO: the browser still logs in at `auth.homectl.no`, so the `homectl_sso`
  cookie continues to short-circuit subsequent apps.
- Access-token TTL and claims are unchanged; the sidecar simply holds and
  refreshes them.

### Observability

- `GET /healthz` (liveness) and `GET /readyz` (readiness — verifies JWKS is
  reachable/cached) on the sidecar port.
- Structured logs for: login start, callback success/failure (with reason),
  refresh success/failure, and upstream proxy errors. No secrets or full tokens
  in logs.

---

## Documentation Requirements (first-class deliverable)

Solid documentation is a **hard requirement**, not an afterthought — the entire
point of the sidecar is to make integration trivial and unambiguous, and the
prior library approach failed precisely because integration was under-documented
and error-prone. The following docs must ship with the implementation and are
part of its definition of done.

### D1. App Integration Guide (`docs/sidecar/integration.md`)

A complete, copy-pasteable walkthrough for an app developer adopting the
sidecar, containing:

1. **Concept in one diagram** — where the sidecar sits and what the browser,
   sidecar, app, and auth service each do.
2. **Register the app** — the `apps.json` entry (id, `clientSecretEnv`,
   `allowedRedirectUris`, `allowedOrigins`, roles) and how the client secret is
   generated and stored (reuse the main README's app-registration steps; link,
   don't duplicate the whole thing).
3. **Kubernetes wiring** — a full annotated Deployment (app + sidecar
   containers), the Service pointing at the sidecar port (`4180`), the
   Ingress pointing at that Service, and the Secret containing `AUTH_CLIENT_SECRET`
   and `COOKIE_KEY`. Base it on `docs/sidecar/deployment.example.yaml` but make
   it production-shaped (probes, resources, `replicas` note about the shared
   `COOKIE_KEY`).
4. **Reading identity in the app** — exactly which headers arrive
   (`Authorization: Bearer …`, `X-Homectl-User`, `X-Homectl-Email`,
   `X-Homectl-Role`), with a short example in at least Node/Express and one
   non-Node language (to prove language independence). Include the JWT claim
   shape (cross-link the main PRD's "JWT Payload Shape").
5. **Frontend expectations** — show that the SPA makes plain same-origin
   `fetch` calls with no token logic, and how it reacts to a `401` (the app's
   choice; the sidecar handles HTML redirects).
6. **Config reference** — the full env-var table above with descriptions and
   defaults.
7. **Local development** — how to run the app without a cluster. Document the
   `devProvider`-style escape hatch (a mode where the sidecar is bypassed or a
   fake identity header is injected) so developers aren't blocked. Be explicit
   that this mode is dev-only and must never be enabled in production.

### D2. Migration Guide (`docs/sidecar/migration.md`)

For apps currently on `@gagnatdev/homectl-auth-client`:

- Before/after architecture.
- Step-by-step: add the sidecar, move identity reads from `req.user` to the
  injected header, remove `bootstrap()`/`authedFetch` from the frontend, delete
  any hand-rolled `/auth/*` gateway, repoint ingress to the sidecar.
- A rollback plan (revert ingress to the app container; the library path still
  works).

### D3. Troubleshooting Guide (`docs/sidecar/troubleshooting.md`)

Must explicitly cover the failure modes we already hit, with symptom → cause →
fix, so the next developer doesn't rediscover them:

- **Redirect loop back to the login screen.** Enumerate the known causes: (a)
  gating HTML on a bearer (library path); (b) a backend proxy calling
  `auth.homectl.no/refresh` without an `Origin` header → `400 unknown_origin`
  (this is why the sidecar uses `/internal/refresh` instead); (c) the app's
  `APP_BASE_URL`/origin not present in the deployed `apps.json`; (d) `iss`/`aud`
  mismatch from misconfigured `PUBLIC_AUTH_URL`/`AUTH_CLIENT_ID`.
- **`403`/`forbidden_origin` or `unknown_origin`** — where client resolution
  happens and why the sidecar avoids the `Origin`-based path.
- **Identity header missing or spoofable** — app exposed directly to ingress
  instead of via the sidecar; inbound header not stripped.
- **Session dropped intermittently under load** — refresh rotation race;
  point to the grace-window follow-up and the access-token-caching mitigation.
- **Cookie not shared across pods** — `COOKIE_KEY` not identical across
  replicas.

### D4. Security Notes (in the integration guide or a dedicated section)

- Why the app must only be reachable via the sidecar.
- The header-stripping guarantee and what the app may therefore trust.
- Restricting `/internal/*` to in-cluster traffic.
- Cookie-key rotation procedure.

### D5. Cross-linking & upkeep

- The main [README](../README.md) "Integrating a New App" section must gain a
  short subsection introducing the sidecar as the recommended path and linking
  to D1, alongside the existing library instructions.
- The [ADR](./adr/0001-forward-auth-sidecar.md) implementation checklist must be
  updated as items land.
- The reference sketch in `docs/sidecar/README.md` should be marked as
  superseded by the real package + guides once implemented (or folded into D1).

### Documentation acceptance criteria

- A developer unfamiliar with homectl-auth can integrate a new app using only
  D1 + the `apps.json` registration steps, without reading the source.
- Every environment variable is documented with purpose, whether required, and
  default.
- Every failure mode listed in D3 has a concrete symptom, root cause, and fix.
- All manifests in the docs are complete and valid (no `...` placeholders in the
  copy-paste path), with clearly marked substitution points.

---

## Testing Decisions

- **Unit:** cookie seal/open round-trip (including tamper rejection); `state`
  sign/verify; `return_to` sanitization (rejects off-site URLs); header
  stripping + injection; the "refresh when near expiry" decision.
- **Integration:** with a stubbed homectl-auth (or the real server via the
  existing Testcontainers setup), exercise: unauthenticated HTML → 302 to
  `/authorize`; unauthenticated XHR → 401; callback with valid/invalid `state`;
  a full login→proxy→refresh cycle; logout clears the session.
- **Security regression:** an inbound request carrying a forged
  `Authorization`/`X-Homectl-*` header must have it stripped before it reaches
  upstream.
- Match the repo's `vitest` conventions and wire into `pnpm -r test`.

## Rollout & Backwards Compatibility

- Strictly additive. No changes to homectl-auth's existing endpoints, cookies,
  or claims are required (the additive `/internal/refresh` already shipped).
- The client library and all current integrations continue to work unchanged.
- Adoption is opt-in **per app**: add the sidecar container and repoint ingress;
  no coordinated change to homectl-auth.
- Suggested first adopter: `workbench` (already attempted a hand-rolled gateway;
  the sidecar replaces it and fixes the loop it hit).

## Out of Scope

- Rewriting or deprecating `@gagnatdev/homectl-auth-client`.
- RBAC/authorization inside the proxy (identity + role are injected; the app
  authorizes).
- A distributed session store (deferred; see "Session model").
- The homectl-auth-side "rotation grace window" and the "server-to-server code
  exchange that returns the refresh token" — both are recommended **follow-ups**
  tracked in ADR 0001, not part of this component's first version (though the
  sidecar should be designed so adopting them later requires no app changes).

## Open Questions

1. **First refresh token:** reuse the existing `.homectl.no` refresh cookie, or
   add the server-to-server exchange variant first? (Recommendation: ship with
   cookie-reuse to avoid blocking on an auth-service change; migrate to the
   body-returned token when the grace-window follow-up lands.)
2. **Access-token caching in the cookie:** cache it (fewer refreshes, larger
   cookie) or re-mint every request window (simpler, more `/internal/refresh`
   calls)? Recommendation: cache, to shrink the rotation-race window.
3. **Framework:** plain Node `http` + a proxy lib, or Express + `http-proxy-middleware`
   (consistent with the rest of the repo)? Recommendation: Express, for
   consistency and testability.
