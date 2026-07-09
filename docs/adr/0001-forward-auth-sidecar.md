# ADR 0001 — Forward-auth sidecar for app integration

- **Status:** Proposed
- **Date:** 2026-07-07
- **Deciders:** homectl-auth maintainers
- **Supersedes / related:** none (first ADR)

## Context

Today a consuming app integrates with homectl-auth through the
`@gagnatdev/homectl-auth-client` library in **two** places:

- **Server** (`packages/client/src/server.ts`): `authMiddleware` verifies the
  JWT, `callbackHandler` runs the authorization-code exchange, `logoutHandler`
  renders a logout page.
- **Browser** (`packages/client/src/browser.ts`): `bootstrap()` fetches an
  access token from `auth.homectl.no/refresh`, `authedFetch` attaches it as a
  `Bearer` header and re-bootstraps on `401`.

This split has three recurring problems:

1. **The frontend is not auth-agnostic.** The SPA must know the auth service
   URL, call `bootstrap()` on load, use `authedFetch`, and handle login
   redirects. Every app re-implements this.

2. **A whole class of integration bugs.** Because HTML navigations never carry
   a `Bearer` header (the access token lives only in JS memory, fetched by
   `bootstrap()` *after* the shell loads), gating an HTML/SPA route with
   `authMiddleware` causes an infinite bounce to `/authorize`. This is exactly
   the loop that forced a revert in the `workbench` app. The README example
   (`app.use(authMiddleware)`) actively encouraged the mistake. We have since
   added a guardrail and corrected the docs, but the underlying two-channel
   design keeps making this easy to get wrong.

3. **Ingress/egress cost.** Server-to-server calls (token exchange, JWKS) can
   already be routed in-cluster via `internalAuthServiceUrl`. What remains on
   the **public ingress** is all *browser ↔ auth* traffic — most importantly
   `POST /refresh` on every page load and every token expiry.

We want most auth interaction to happen over Kubernetes service discovery
(ClusterIP), the frontend to be unaware it is talking to homectl-auth, and the
backend to own token handling, refresh, and login redirects.

## Decision

Adopt the **forward-auth (BFF) sidecar** pattern as the recommended integration
for apps, **without breaking the existing client-library integration**.

A small `homectl-auth-proxy` sidecar runs in each app pod. Ingress routes the
app's hostname to the **sidecar**, which proxies to the app container:

```
Browser ──HTTPS──▶ Ingress ──▶ [ pod: sidecar :4180 ──▶ app :3000 ]
                                        │
                                        └── in-cluster ──▶ homectl-auth ClusterIP
```

The sidecar:

- Terminates the browser session with its **own** opaque, HttpOnly session
  cookie (the browser holds no JWT).
- Runs the authorization-code flow: unauthenticated navigation → 302 to the
  public `/authorize`; handles the callback; exchanges the code in-cluster.
- Holds the refresh token server-side and mints/refreshes access tokens
  **in-cluster** via the new `POST /internal/refresh` endpoint.
- Injects identity into the proxied request as headers
  (`Authorization: Bearer <jwt>` and/or `X-Homectl-User`, `X-Homectl-Email`,
  `X-Homectl-Role`), after **stripping** any inbound copies of those headers so
  they cannot be spoofed from the internet.

The app backend trusts the injected header. The frontend does nothing
auth-specific — it just makes same-origin requests.

### New server endpoint: `POST /internal/refresh`

The browser-facing `POST /refresh` derives the client from the `Origin` header
and reads/writes the refresh **cookie** — neither is available to a
server-to-server caller. So we add a machine-to-machine sibling.

```
POST /internal/refresh
Content-Type: application/json
{ "client_id": "...", "client_secret": "...", "refresh_token": "..." }

200 OK
{
  "access_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "<rotated opaque token>",
  "refresh_expires_in": 2592000
}
```

- **Auth:** `client_id` + `client_secret`, bcrypt-compared against the app's
  configured hash — identical trust to the `/token` exchange
  (`verifyClientSecret`, `packages/server/src/modules/client/client.service.ts`).
- **Rotation:** reuses `rotateSession` — the presented token is invalidated and
  a new one issued. The rotated token is returned **in the JSON body**, never as
  a `Set-Cookie`. The caller owns storage.
- **Revocation:** if the user no longer has access to the app, the freshly
  rotated session is deleted and the call returns `403 access_revoked`.
- **Reachability:** mounted on the same app but intended for the ClusterIP
  Service. It requires the client secret, so exposure over ingress is no worse
  than `/token`; still, restrict it to in-cluster traffic (see Security).

Implementation: `packages/server/src/routes/internal.router.ts`.

### Session strategy across multiple pods

**No distributed session store is required for the common case.** The durable
session state already lives centrally in homectl-auth's `sessions` table; the
sidecar only needs a valid access token per request. Run the sidecar
**stateless** with an **encrypted-cookie session**:

- The refresh token lives in an AES-encrypted, HttpOnly cookie; the short-lived
  access token can ride in the same cookie or be re-minted on demand.
- All replicas share one symmetric cookie-encryption key from a Kubernetes
  Secret, so any request can land on any pod. No Redis, no sticky sessions.
- Access-token verification is stateless JWKS (each pod caches the JWKS).

**The one multi-pod hazard is refresh-token rotation.** `rotateSession` deletes
the old token and issues a new one on every refresh, so two concurrent refreshes
for the same session (different pods, or multiple browser tabs) race — one wins,
the other's token is invalidated and that session drops. Mitigations, cheapest
first:

1. Cache the access token in the session cookie so refreshes are rare
   (~once per 15 min), shrinking the race window.
2. **Recommended follow-up:** add a short **rotation grace window** server-side
   — accept the immediately-previous refresh token for ~10–30s after rotation.
   This also fixes multi-tab races for the *existing* cookie-based `/refresh`.
   (Not implemented in this change to preserve current rotation semantics; see
   Consequences.)
3. Only if contention persists: a small shared lock (Redis) to serialize
   refresh. This is the *only* thing that would pull us toward a distributed
   store.

## Backwards compatibility

This is strictly additive. Nothing about the existing integration changes:

- `/authorize`, `/login`, `/token`, `/refresh`, `/logout`, JWKS, cookies, and
  token claims are untouched.
- The `@gagnatdev/homectl-auth-client` library keeps working as-is. Apps using
  it need not adopt the sidecar.
- `/internal/refresh` is a new route; the SPA-shell fallback in `app.ts` was
  updated so `/internal/*` returns JSON `404` rather than the SPA shell,
  matching the other API paths.
- The sidecar is opt-in **per app**. An app can migrate by adding the sidecar
  container and pointing ingress at it, with no change to homectl-auth.

## Security considerations

- **Header spoofing.** The sidecar MUST strip inbound `Authorization` and
  `X-Homectl-*` headers before injecting its own, so a client cannot forge
  identity by sending those headers to the ingress.
- **`/internal/refresh` exposure.** It is client-secret-authenticated (same as
  `/token`), so public reachability is not a new secret-exposure risk. Still,
  restrict it to in-cluster callers via NetworkPolicy and/or an ingress path
  exclusion for `/internal/`, as defense in depth.
- **Cookie key management.** The sidecar's cookie-encryption key is a shared
  secret across replicas; rotate it like any other secret and store it in the
  cluster Secret store.
- **No JWT in the browser.** Moving the JWT behind the sidecar removes the
  XSS token-exfiltration surface that the in-memory-token model still carries.

## Alternatives considered

- **Option B — backend-mediated JWT (keep in-memory token in the SPA).** Keep
  the current browser model but point `bootstrap()`/refresh at the app's own
  origin, backed by `/internal/refresh` in the app server. Smaller change, keeps
  a JWT in the browser, but the frontend still does a little auth work and each
  backend re-implements the mediation. Good lighter alternative;
  `/internal/refresh` (this ADR) is the shared building block either way.
- **Status quo (client library only).** Rejected as the default because it keeps
  the two-channel footgun and the recurring browser↔auth ingress cost.
- **Distributed session store (Redis) from day one.** Rejected as unnecessary
  for the common case; adds an operational dependency we can defer until
  rotation races or cookie-size limits actually bite.

## Consequences

**Positive**

- Frontends become auth-agnostic; the login-loop class of bugs disappears for
  sidecar apps (the sidecar gates HTML on a session cookie, not a bearer).
- Browser↔auth ingress traffic drops to interactive login only.
- homectl-auth becomes usable by apps in any language, not just Node/Express.

**Negative / follow-ups**

- One extra network hop (sidecar → app) and a new component to operate.
- App backends must trust an injected header and rely on the sidecar to strip
  spoofed inbound headers.
- Refresh-token rotation races are mitigated but not eliminated until the
  grace-window follow-up lands. Tracked as the recommended next step.

## Implementation status

- [x] `POST /internal/refresh` endpoint + `verifyClientSecret`
- [x] SPA-shell fallback excludes `/internal/*`
- [x] Client-library guardrail against the HTML auth loop + README fix
- [x] `homectl-auth-proxy` sidecar image (`packages/proxy`, `Dockerfile.proxy`,
      CI build/push) with integration, migration, and troubleshooting guides in
      [`docs/sidecar/`](../sidecar/). The original reference sketch is superseded
      by the real package + guides.
- [ ] Server-to-server code exchange returning the refresh token in the body
      (lets the sidecar stop reusing the browser refresh cookie — follow-up)
- [ ] Rotation grace window in `rotateSession` (recommended follow-up)
- [ ] NetworkPolicy / ingress exclusion restricting `/internal/*` to in-cluster
