# `@homectl/proxy` — homectl-auth-proxy

Forward-auth sidecar for homectl-auth. A **deployable service** (shipped as the
`homectl-auth-proxy` Docker image via `Dockerfile.proxy`), **not** an npm
package — it is `private` and never published.

It runs as a second container in a consuming app's pod: ingress targets the
sidecar (`:4180`), the sidecar authenticates the browser with its own encrypted
session cookie, runs the OAuth flow, refreshes tokens in-cluster against
`/internal/refresh`, and proxies each request to the app container with a
**verified identity injected as request headers**. The app frontend is
auth-agnostic and the backend does no auth work.

## Documentation

- **[Integration guide](../../docs/sidecar/integration.md)** — config, full
  Kubernetes manifest, reading identity, frontend expectations, local dev, and
  security notes.
- **[Migration guide](../../docs/sidecar/migration.md)** — moving an app off
  `@gagnatdev/homectl-auth-client`.
- **[Troubleshooting](../../docs/sidecar/troubleshooting.md)** — every known
  failure mode (symptom → cause → fix).
- **[PRD](../../docs/prd-sidecar-proxy.md)** and
  **[ADR 0001](../../docs/adr/0001-forward-auth-sidecar.md)** — why it exists.

## Scripts

```bash
pnpm --filter @homectl/proxy dev         # tsx watch (needs env vars set)
pnpm --filter @homectl/proxy build       # tsc → dist
pnpm --filter @homectl/proxy test        # vitest (no DB / cluster needed)
pnpm --filter @homectl/proxy typecheck
```

Configuration is entirely via environment variables, validated at startup — see
the config reference in the integration guide.
