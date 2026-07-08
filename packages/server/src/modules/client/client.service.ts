/**
 * Client credential verification for server-to-server ("machine") endpoints.
 *
 * Same trust model as the /token authorization-code exchange: the caller
 * proves it is a registered app by presenting the app's client_secret, which
 * is bcrypt-compared against the hash in the env var named by the app's
 * `clientSecretEnv`. Used by endpoints that cannot rely on a browser Origin
 * (e.g. an in-cluster auth sidecar calling /internal/refresh).
 */

import bcrypt from 'bcryptjs';
import { getApp, getClientSecretHash } from '../../config/apps';

/**
 * Verify a client_id + client_secret pair. Returns false (never throws) for an
 * unknown client, a missing secret hash, or a mismatch — callers map this to a
 * single `invalid_client` response so they don't leak which check failed.
 */
export async function verifyClientSecret(
  clientId: string,
  clientSecret: string,
): Promise<boolean> {
  const app = getApp(clientId);
  if (!app) return false;

  let secretHash: string;
  try {
    secretHash = getClientSecretHash(app);
  } catch {
    return false;
  }

  return bcrypt.compare(clientSecret, secretHash);
}
