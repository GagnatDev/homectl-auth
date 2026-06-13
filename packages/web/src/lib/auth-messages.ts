/**
 * Maps the error codes the server appends as `?error=` on the public auth pages
 * to human-readable messages. Keys cover login, invite, and reset-password.
 */
const MESSAGES: Record<string, string> = {
  // login
  invalid_credentials: 'Invalid username or password.',
  no_access: 'You do not have access to this application.',
  // shared form validation
  missing_fields: 'All fields are required.',
  password_too_short: 'Password must be at least 8 characters.',
  // invite / reset token outcomes
  INVALID_TOKEN: 'This link is invalid.',
  EXPIRED_TOKEN: 'This link has expired.',
  ALREADY_USED: 'This link has already been used.',
  EMAIL_RACE: 'This link cannot be used — the email address has already been claimed.',
  USER_NOT_FOUND: 'Account not found.',
};

export function authErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? 'Something went wrong. Please try again.';
}
