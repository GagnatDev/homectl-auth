/**
 * Token Module
 *
 * Issues and verifies RS256-signed JWTs.  The private key is loaded once at
 * module initialisation time from the RS256_PRIVATE_KEY_PEM environment variable
 * (base64-encoded PEM).  The public key is exposed via getJwks() for the
 * /.well-known/jwks.json endpoint.
 */

import {
  importPKCS8,
  importSPKI,
  exportJWK,
  SignJWT,
  jwtVerify,
  generateKeyPair,
  type JWTPayload,
  type KeyLike,
} from 'jose';
import { createHash } from 'crypto';

// ── Key loading ────────────────────────────────────────────────────────────

// In production the key pair lives in an env var.  In tests, generateTestKeys()
// is used instead so that no real secret is needed.

type KeyState = {
  privateKey: KeyLike;
  publicKey: KeyLike;
  kid: string;
};

let _keys: KeyState | null = null;

/**
 * Load keys from environment or throw.  Call once at startup.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function loadKeys(): Promise<void> {
  if (_keys) return;

  const privatePemB64 = process.env['RS256_PRIVATE_KEY_PEM'];
  const publicPemB64 = process.env['RS256_PUBLIC_KEY_PEM'];

  if (!privatePemB64 || !publicPemB64) {
    throw new Error(
      'RS256_PRIVATE_KEY_PEM and RS256_PUBLIC_KEY_PEM environment variables are required',
    );
  }

  const privatePem = Buffer.from(privatePemB64, 'base64').toString('utf-8');
  const publicPem = Buffer.from(publicPemB64, 'base64').toString('utf-8');

  const privateKey = await importPKCS8(privatePem, 'RS256');
  const publicKey = await importSPKI(publicPem, 'RS256');

  // Derive a stable kid from the public key's DER thumbprint
  const kid = deriveKid(publicPem);

  _keys = { privateKey, publicKey, kid };
}

/**
 * Generate a fresh RS256 key pair for use in tests.
 * Overwrites any previously loaded keys.
 */
export async function generateTestKeys(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  const kid = createHash('sha256').update(JSON.stringify(jwk)).digest('hex').slice(0, 16);
  _keys = { privateKey, publicKey, kid };
}

/** Reset keys — used in tests to ensure isolation. */
export function resetKeys(): void {
  _keys = null;
}

function getKeys(): KeyState {
  if (!_keys) {
    throw new Error('Token keys not loaded. Call loadKeys() or generateTestKeys() first.');
  }
  return _keys;
}

function deriveKid(publicPem: string): string {
  return createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
}

// ── JWT payload ────────────────────────────────────────────────────────────

export type AppClaim = {
  appId: string;
  role: string;
};

export type AccessTokenPayload = {
  /** Issuer — always https://auth.homectl.no (or ISS env var) */
  iss: string;
  /** Audience — the client_id the token was issued for */
  aud: string;
  /** Subject — user id */
  sub: string;
  email: string;
  isAdmin: boolean;
  /** All apps the user has access to */
  apps: AppClaim[];
  iat: number;
  exp: number;
};

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

function getIssuer(): string {
  return process.env['AUTH_SERVICE_URL'] ?? 'https://auth.homectl.no';
}

// ── Sign ───────────────────────────────────────────────────────────────────

export type SignAccessTokenInput = {
  sub: string;
  email: string;
  isAdmin: boolean;
  apps: AppClaim[];
  /** The client_id this token is being issued for (becomes aud) */
  clientId: string;
};

export async function signAccessToken(input: SignAccessTokenInput): Promise<string> {
  const { privateKey, kid } = getKeys();
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    email: input.email,
    isAdmin: input.isAdmin,
    apps: input.apps,
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(getIssuer())
    .setAudience(input.clientId)
    .setSubject(input.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(privateKey);
}

// ── Verify ─────────────────────────────────────────────────────────────────

/**
 * Verify an access token issued by this service.
 *
 * Validates:
 *  - RS256 signature
 *  - iss === AUTH_SERVICE_URL
 *  - aud === expectedClientId (when provided)
 *  - exp is in the future
 *
 * Throws JWTExpired, JWTClaimValidationFailed, or JWSSignatureVerificationFailed
 * on any failure.
 */
export async function verifyAccessToken(
  token: string,
  expectedClientId?: string,
): Promise<AccessTokenPayload> {
  const { publicKey } = getKeys();

  const verifyOptions: Parameters<typeof jwtVerify>[2] = {
    issuer: getIssuer(),
    algorithms: ['RS256'],
  };
  if (expectedClientId) {
    verifyOptions.audience = expectedClientId;
  }

  const { payload } = await jwtVerify(token, publicKey, verifyOptions);

  return {
    iss: payload['iss'] as string,
    aud: payload['aud'] as string,
    sub: payload['sub'] as string,
    email: payload['email'] as string,
    isAdmin: payload['isAdmin'] as boolean,
    apps: payload['apps'] as AppClaim[],
    iat: payload['iat'] as number,
    exp: payload['exp'] as number,
  };
}

// ── JWKS ───────────────────────────────────────────────────────────────────

type JwksResponse = {
  keys: Array<{
    kty: string;
    use: string;
    alg: string;
    kid: string;
    [key: string]: unknown;
  }>;
};

export async function getJwks(): Promise<JwksResponse> {
  const { publicKey, kid } = getKeys();
  const jwk = await exportJWK(publicKey);

  return {
    keys: [
      {
        ...jwk,
        use: 'sig',
        alg: 'RS256',
        kid,
      },
    ],
  };
}
