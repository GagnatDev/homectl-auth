/**
 * Client credential verification for server-to-server ("machine") endpoints.
 *
 * Same trust model as the /token authorization-code exchange: the caller
 * proves it is a registered app by presenting the app's client_secret, which
 * is constant-time-compared against the plaintext value in the env var named
 * by the app's `clientSecretEnv` (Terraform-generated and shared with the
 * app's own AUTH_CLIENT_SECRET — see homectl-infra's auth-client-secrets
 * Secret). Used by endpoints that cannot rely on a browser Origin (e.g. an
 * in-cluster auth sidecar calling /internal/refresh).
 */

import { timingSafeEqual } from 'crypto';
import { getApp, getClientSecret } from '../../config/apps';

/** Constant-time string equality, safe for comparing secrets of differing length. */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a client_id + client_secret pair. Returns false (never throws) for an
 * unknown client, a missing secret, or a mismatch — callers map this to a
 * single `invalid_client` response so they don't leak which check failed.
 */
export async function verifyClientSecret(
  clientId: string,
  clientSecret: string,
): Promise<boolean> {
  const app = getApp(clientId);
  if (!app) return false;

  let secret: string;
  try {
    secret = getClientSecret(app);
  } catch {
    return false;
  }

  return secretsMatch(clientSecret, secret);
}
