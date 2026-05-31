/**
 * GitHub OAuth Module
 *
 * Implements the minimal GitHub OAuth web flow used to authenticate the system
 * owner into the admin panel.  No external library is needed — GitHub's OAuth
 * endpoints are plain HTTP, served here via Node's built-in fetch.
 *
 * The admin is NOT a local user: a successful login maps a GitHub numeric user
 * ID (checked against the GITHUB_ADMIN_USER_IDS allowlist) directly onto an
 * admin JWT.  No row is written to homectl_auth.users.
 */

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';

const OAUTH_SCOPE = 'read:user user:email';

export type GithubUser = { id: number; login: string };

function clientId(): string {
  const id = process.env['GITHUB_ADMIN_CLIENT_ID'];
  if (!id) throw new Error('GITHUB_ADMIN_CLIENT_ID is not set');
  return id;
}

function clientSecret(): string {
  const secret = process.env['GITHUB_ADMIN_CLIENT_SECRET'];
  if (!secret) throw new Error('GITHUB_ADMIN_CLIENT_SECRET is not set');
  return secret;
}

/**
 * Build the GitHub authorize URL the browser is redirected to.
 * `state` is an opaque CSRF token also stored in a short-lived cookie.
 */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    scope: OAUTH_SCOPE,
    state,
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange an authorization code for an access token. */
export async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status}`);
  }

  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) {
    throw new Error(`GitHub token exchange returned no token: ${body.error ?? 'unknown_error'}`);
  }
  return body.access_token;
}

/** Fetch the authenticated GitHub user's numeric id and login. */
export async function getUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'homectl-auth',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub user fetch failed: ${res.status}`);
  }

  const body = (await res.json()) as { id?: number; login?: string };
  if (typeof body.id !== 'number' || !body.login) {
    throw new Error('GitHub user fetch returned an unexpected shape');
  }
  return { id: body.id, login: body.login };
}

/**
 * Fetch the user's primary, verified email.  Returns null if none is available
 * (e.g. the user keeps their email private and grants no verified primary).
 */
export async function getPrimaryEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(GITHUB_EMAILS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'homectl-auth',
    },
  });

  if (!res.ok) return null;

  const body = (await res.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
  const primary = body.find((e) => e.primary && e.verified);
  return primary?.email ?? null;
}

/** Check whether a GitHub numeric user id is in the admin allowlist. */
export function isAllowed(githubUserId: number): boolean {
  const raw = process.env['GITHUB_ADMIN_USER_IDS'] ?? '';
  const allowed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return allowed.includes(String(githubUserId));
}
