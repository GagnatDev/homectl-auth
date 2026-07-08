# Troubleshooting the `homectl-auth-proxy` sidecar

Every entry is a failure mode we have actually hit (or designed the sidecar to
avoid), written as **symptom → cause → fix**. If you are seeing a redirect loop,
start there.

---

## Redirect loop back to the login screen

**Symptom:** the browser bounces between your app and `auth.homectl.no/authorize`
(or `/login`) forever, never settling on a logged-in page.

There are several distinct causes; work through them in order.

### (a) Gating HTML on a bearer (the library-path bug — not the sidecar)

**Cause:** an app on `@gagnatdev/homectl-auth-client` put `authMiddleware` in
front of an HTML route. A browser never attaches a `Bearer` header to a
top-level navigation (the token lives in JS memory, fetched *after* the shell
loads), so the middleware redirects every page load to `/authorize`, which comes
back with still no header → loop.

**Fix:** this does not apply to the sidecar — it gates HTML on the `hs_session`
cookie, not a bearer, so the loop cannot occur. If you see this, you are still
on the library path; either finish the migration or gate only your `/api` routes
(see the main README).

### (b) A backend proxying `/refresh` without an `Origin` header → `400 unknown_origin`

**Cause:** a hand-rolled backend that forwarded the browser's refresh call to
`auth.homectl.no/refresh` server-to-server, sending only cookies. `/refresh`
resolves the calling app **from the `Origin` header**, so with no `Origin` it
returns `400 unknown_origin`, the SPA never gets a token, and it loops.

**Fix:** this is exactly why the sidecar refreshes against **`/internal/refresh`**
(client-secret authenticated, no `Origin`, no cookies) instead of `/refresh`.
Delete the hand-rolled `/refresh` proxy. If you still see `unknown_origin`,
something in your app is still calling `/refresh` — remove it.

### (c) The app's origin / redirect URI is not in `apps.json`

**Cause:** `${APP_BASE_URL}${CALLBACK_PATH}` is not listed in the app's
`allowedRedirectUris` (or the deployed `apps.json` is stale). `/authorize` and
`/token` reject the mismatch, so login never completes.

**Fix:** ensure `allowedRedirectUris` contains the exact callback URL the sidecar
sends — with defaults that is `https://<host>/auth/callback`. Redeploy
homectl-auth if you edited `apps.json`. Check the sidecar log line
`login callback failed` and the `/token` response.

### (d) `iss` / `aud` mismatch from misconfigured `PUBLIC_AUTH_URL` / `AUTH_CLIENT_ID`

**Cause:** the sidecar verifies every access token with `issuer = PUBLIC_AUTH_URL`
and `audience = AUTH_CLIENT_ID`. If `PUBLIC_AUTH_URL` does not match the issuer
homectl-auth signs with (`https://auth.homectl.no`), or `AUTH_CLIENT_ID` is not
the registered id, verification throws, the callback/refresh fails, and the user
is bounced back to login.

**Fix:** set `PUBLIC_AUTH_URL` to the exact issuer string (no trailing path,
scheme included) and `AUTH_CLIENT_ID` to the `apps.json` `id`. A refresh failure
is logged as `refresh failed; forcing re-login` with the underlying reason.

---

## `403` / `forbidden_origin` or `400 unknown_origin`

**Symptom:** calls to homectl-auth return `forbidden_origin` or `unknown_origin`.

**Cause:** these come from the **`Origin`-based** browser endpoints (`/refresh`,
`/logout`) when the `Origin` is absent or not allow-listed. Client resolution
for those endpoints happens from `Origin`.

**Fix:** the sidecar deliberately avoids the `Origin`-based path. It uses
`/token` and `/internal/refresh`, which authenticate with `client_id` +
`client_secret` and never look at `Origin`. If you are seeing these errors, some
code is still hitting `/refresh` or `/logout` directly — it should not be. Route
all server-to-server auth calls through the sidecar's `/internal/refresh` flow.

---

## Identity header missing or spoofable

**Symptom:** your app sees no `X-Homectl-User`, or worse, it sees a value a
client set themselves.

**Cause & fix — missing:** the request did not go through the sidecar, or there
is no session. Confirm the Service `targetPort` is `4180` (the sidecar), not
your app port. For an authenticated request the sidecar always injects the
headers; for an unauthenticated XHR it returns `401` (no headers) rather than
redirect.

**Cause & fix — spoofable:** your app container is reachable **directly** from
the ingress, bypassing the sidecar. The sidecar strips inbound `Authorization`
and `X-Homectl-*` on every request, but only for traffic that flows *through*
it. Ensure the app port is pod-local and never a Service target or ingress
backend. This is the single most important deployment invariant — see
integration.md §8.

---

## Session dropped intermittently under load

**Symptom:** occasional unexpected logouts or `401`s, more frequent under
concurrency (many tabs, many pods).

**Cause:** the refresh-token **rotation race**. `/internal/refresh` deletes the
old refresh token and issues a new one on every refresh. If two requests for the
same session refresh at once (different pods, or multiple browser tabs), one
wins and the other's token is already dead.

**Mitigations (in effect / planned):**

- The sidecar **caches the access token in the cookie** and only refreshes
  within `REFRESH_SKEW_SECONDS` of expiry (~once per 15 min), so the race window
  is small. This is already in place.
- The recommended homectl-auth follow-up is a **rotation grace window** — accept
  the immediately-previous refresh token for ~10–30s after rotation. This
  eliminates the race (and also fixes multi-tab races for the library
  `/refresh`). Tracked in [ADR 0001](../adr/0001-forward-auth-sidecar.md).
- Only if contention persists after the grace window: a small shared lock
  (Redis). Deferred until measured — do not add it preemptively.

If you see this frequently *before* the grace window lands, raise
`REFRESH_SKEW_SECONDS` modestly is **not** a fix (it widens, not narrows, the
window); instead reduce concurrent refreshes by ensuring the access token is
actually being cached (check for repeated `access token refreshed` log lines on
back-to-back requests, which would indicate the cookie is not being persisted —
see the next entry).

---

## Cookie not shared across pods / session lost on every other request

**Symptom:** with multiple replicas, a session established on one pod is not
recognized on another; logging in "works" then immediately fails.

**Cause:** `COOKIE_KEY` is **not identical** across replicas. The session lives
in an AES-256-GCM cookie; a pod can only open a cookie sealed with its own key.
Different keys ⇒ every cross-pod request looks unauthenticated.

**Fix:** `COOKIE_KEY` must be one value shared by all replicas. Source it from a
single Kubernetes Secret (as in integration.md §3) — do not generate it per-pod,
per-container, or in an init step. After rotating it, expect a one-time wave of
re-logins (old cookies can no longer be opened).

---

## Readiness probe failing (`/readyz` → 503)

**Symptom:** the sidecar container never becomes Ready; `/readyz` returns `503`.

**Cause:** `/readyz` verifies the JWKS endpoint is reachable and non-empty. A
`503` means the sidecar cannot fetch `${INTERNAL_AUTH_URL}/.well-known/jwks.json`.

**Fix:** check `INTERNAL_AUTH_URL` resolves in-cluster (the ClusterIP Service
name, e.g. `http://homectl-auth.homectl`), that homectl-auth is up, and that no
NetworkPolicy blocks the sidecar → homectl-auth path. `/healthz` (liveness) does
**not** depend on JWKS, so a healthy-but-not-ready container points squarely at
JWKS reachability.

---

## The sidecar exits immediately at startup

**Symptom:** the container crash-loops; logs show
`Invalid homectl-auth-proxy configuration:` followed by a list.

**Cause:** a required env var is missing or malformed (e.g. `COOKIE_KEY` not
exactly 32 bytes of base64, a non-URL `PUBLIC_AUTH_URL`, or `DEV_FAKE_IDENTITY`
set while `NODE_ENV=production`).

**Fix:** the log lists every problem with the offending variable name. Fix each
and redeploy. This is intentional fail-fast behavior — misconfiguration never
silently degrades into a runtime auth failure.
