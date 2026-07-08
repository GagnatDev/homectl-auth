/**
 * Open-redirect guard for the post-login `return_to` target.
 *
 * After login the sidecar 302s the browser to wherever it was originally
 * headed. That target is attacker-influenceable, so we only ever allow a
 * same-origin *relative path* — never an absolute or protocol-relative URL that
 * could bounce the user off-site. Anything suspicious collapses to '/'.
 */
export function sanitizeReturnTo(raw: string | undefined | null): string {
  if (!raw || typeof raw !== 'string') return '/';

  // Must be an absolute path on this origin.
  if (!raw.startsWith('/')) return '/';
  // Reject protocol-relative ("//evil.com") and backslash variants ("/\evil").
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // Reject anything carrying a scheme or control characters.
  if (/[\x00-\x1f]/.test(raw)) return '/';
  if (raw.includes('\\')) return '/';
  // A stray "://" anywhere is a strong smell of an absolute URL sneaking in.
  if (raw.includes('://')) return '/';

  return raw;
}
