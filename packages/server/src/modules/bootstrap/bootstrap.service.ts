import { anyAdminExists, createUser } from '../user/user.repository';
import { hashPassword } from '../user/password.service';
import { logger } from '../../logger';

export async function validateBootstrapConfig(): Promise<void> {
  const adminExists = await anyAdminExists();
  if (!adminExists && !process.env['BOOTSTRAP_ADMIN_EMAIL']) {
    throw new Error(
      'BOOTSTRAP_ADMIN_EMAIL must be set when no admin user exists. ' +
        'Set it via Kubernetes secret or remove it after bootstrapping.',
    );
  }
  if (adminExists && process.env['BOOTSTRAP_ADMIN_EMAIL']) {
    logger.info('Admin already exists — BOOTSTRAP_ADMIN_EMAIL is set but will be ignored');
  }
}

type BootstrapResult =
  | { ok: true }
  | { ok: false; error: 'UNAVAILABLE' | 'INVALID_EMAIL' | 'WEAK_PASSWORD' | 'CONFLICT' };

export async function bootstrapAdmin(input: {
  username: string;
  password: string;
  submittedEmail: string;
}): Promise<BootstrapResult> {
  const approvedEmail = process.env['BOOTSTRAP_ADMIN_EMAIL'];

  const adminExists = await anyAdminExists();
  if (adminExists || !approvedEmail) {
    return { ok: false, error: 'UNAVAILABLE' };
  }

  if (input.submittedEmail.trim().toLowerCase() !== approvedEmail.trim().toLowerCase()) {
    return { ok: false, error: 'UNAVAILABLE' };
  }

  if (input.password.length < 8) {
    return { ok: false, error: 'WEAK_PASSWORD' };
  }

  const passwordHash = await hashPassword(input.password);

  try {
    await createUser({
      email: approvedEmail.trim().toLowerCase(),
      username: input.username.trim(),
      passwordHash,
      isAdmin: true,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return { ok: false, error: 'CONFLICT' };
    }
    throw err;
  }

  logger.info({ username: input.username }, 'Bootstrap admin created');
  return { ok: true };
}
