// @gagnatdev/homectl-auth-client/server
// Server-side Express integration — full implementation in Phase 6.

export type AuthClientOptions = {
  /** Base URL of the auth service, e.g. https://auth.homectl.no */
  authServiceUrl: string;
  /** JWKS URL — defaults to ${authServiceUrl}/.well-known/jwks.json */
  jwksUrl?: string;
  /** The app's client_id as registered in the auth service config */
  clientId: string;
  /** The app's client_secret (read from env in consuming app) */
  clientSecret: string;
  /** The public-facing base URL of the consuming app, e.g. https://reisedagbok.homectl.no */
  appBaseUrl: string;
  /** Path where the auth callback is handled — default /auth/callback */
  callbackPath?: string;
};

export type AuthUser = {
  id: string;
  email: string;
  isAdmin: boolean;
  role: string;
};

// Stub — full implementation in Phase 6
export function createAuthClient(_options: AuthClientOptions): never {
  throw new Error('@gagnatdev/homectl-auth-client/server — not implemented yet (Phase 6)');
}
