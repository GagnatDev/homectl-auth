# Migrating from `@gagnatdev/homectl-auth-client` to the sidecar

For an app currently integrated with the client library. The migration is
**opt-in and reversible**: homectl-auth is unchanged, so you can repoint ingress
back to the app container at any time and the library path still works.

Read [`integration.md`](./integration.md) first — this guide only covers the
delta from a library app.

---

## Before / after

**Before (library):**

```
Browser ──▶ Ingress ──▶ app :3000
  bootstrap() ─▶ auth.homectl.no/refresh   (public ingress, every page load)
  authedFetch attaches Bearer from JS memory
app server: authMiddleware verifies Bearer, callbackHandler exchanges code,
            logoutHandler renders logout page
```

The frontend knows the auth service, holds a token in memory, and each app
re-implements the redirect/refresh wiring. Refresh hits the public ingress.

**After (sidecar):**

```
Browser ──▶ Ingress ──▶ sidecar :4180 ──▶ app :3000
  browser holds only hs_session; makes same-origin fetches
sidecar: runs the OAuth flow, refreshes via /internal/refresh (in-cluster),
         injects X-Homectl-* + Bearer
app server: reads a header. No auth code.
```

The frontend is auth-agnostic and refresh traffic leaves the public ingress.

---

## Step by step

### 1. Register / reuse the client secret

Your app is already registered in `apps.json` with a `clientSecretEnv`. You need
the **plaintext** client secret for the sidecar's `AUTH_CLIENT_SECRET`. If you
still have it, reuse it. If not, regenerate: create a new plaintext secret,
store its bcrypt hash under the existing `clientSecretEnv` in homectl-auth, and
put the plaintext in the app's Secret (see integration.md §2). Confirm
`allowedRedirectUris` contains `${APP_BASE_URL}/auth/callback`.

Generate `COOKIE_KEY` (`openssl rand -base64 32`) and add both `COOKIE_KEY` and
`AUTH_CLIENT_SECRET` to the app's Secret.

### 2. Add the sidecar container

Add the `auth-proxy` container and its env to your Deployment, per
integration.md §3. Keep your app container as-is for now.

### 3. Repoint the Service at the sidecar

Change the Service `targetPort` from your app port (`3000`) to the sidecar port
(`4180`). Ingress already points at the Service, so no ingress change is needed
unless you add the `/internal/*` exclusion (recommended).

At this point ingress → Service → sidecar → app.

### 4. Move identity reads from `req.user` to the header

The library populated `req.user` from a verified `Bearer`. Replace that with a
read of the injected headers:

```diff
- app.use(authMiddleware);              // from @gagnatdev/homectl-auth-client/server
- app.get('/api/x', (req, res) => {
-   const email = req.user.email;
-   const role = req.user.role;
+ app.use((req, res, next) => {
+   req.user = {
+     id: req.get('x-homectl-user'),
+     email: req.get('x-homectl-email'),
+     role: req.get('x-homectl-role') ?? null,
+   };
+   if (!req.user.id) return res.status(401).json({ error: 'unauthenticated' });
+   next();
+ });
+ app.get('/api/x', (req, res) => {
+   const email = req.user.email;
+   const role = req.user.role;
```

Your authorization logic (role checks) stays exactly the same — only the
*source* of identity changes.

### 5. Delete the hand-rolled auth wiring

- Remove `callbackHandler` / `logoutHandler` routes and `authMiddleware` — the
  sidecar owns `/auth/callback` and `/auth/logout` now. (Point your logout
  button at `POST /auth/logout`; the sidecar handles it.)
- Delete any hand-rolled `/auth/*` gateway or backend proxy of
  `auth.homectl.no/refresh` — the sidecar replaces it. (A backend that proxied
  `/refresh` is exactly what hit the `400 unknown_origin` loop; the sidecar uses
  `/internal/refresh` and avoids it.)
- Drop the `@gagnatdev/homectl-auth-client` server import.

### 6. Remove browser auth from the frontend

- Delete `bootstrap()` and `authedFetch`; the browser helper import goes away.
- Replace `authedFetch('/api/x')` with plain `fetch('/api/x')`.
- Remove any client-side redirect-to-login logic — the sidecar redirects
  top-level navigations, and returns `401` to XHRs for the SPA to handle
  (typically a full-page reload). See integration.md §5.

### 7. Deploy and verify

- Load a page: a fresh browser should 302 to `auth.homectl.no`, log in (or SSO),
  return, and land on the app with a working session.
- Confirm your API sees `X-Homectl-User` / `-Email` / `-Role`.
- Confirm the browser has an `hs_session` cookie and **no** access token in JS.

---

## Rollback plan

The library path is untouched, so rollback is a config change, not a code
revert:

1. Change the Service `targetPort` back to your app port (`3000`).
2. Re-enable the library integration you removed (or keep it behind a flag
   during migration so rollback is instant).

Because homectl-auth was never changed, both integration styles remain valid
simultaneously; you can even run the sidecar in staging and the library in
production until you are confident.
