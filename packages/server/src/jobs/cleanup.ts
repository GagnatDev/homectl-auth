/**
 * Expired row cleanup job
 *
 * Runs once a day and deletes rows that expired more than 1 day ago from:
 *   - authorization_codes
 *   - invite_tokens
 *   - password_reset_tokens
 *   - sessions
 *
 * The 1-day grace period lets short-lived debugging inspect expired rows.
 * For sessions it is irrelevant because expired tokens fail validation regardless.
 */

import { getPool } from '../db';
import { logger } from '../logger';
import { getActivityRetentionDays } from '../modules/activity/activity.service';
import { deleteEventsOlderThanDays } from '../modules/activity/activity.repository';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

let _interval: ReturnType<typeof setInterval> | null = null;

export async function runCleanup(): Promise<void> {
  const pool = getPool();
  const tables = [
    'homectl_auth.authorization_codes',
    'homectl_auth.invite_tokens',
    'homectl_auth.password_reset_tokens',
    'homectl_auth.sessions',
  ];

  let totalDeleted = 0;

  for (const table of tables) {
    const { rowCount } = await pool.query(
      `DELETE FROM ${table} WHERE expires_at < NOW() - INTERVAL '1 day'`,
    );
    totalDeleted += rowCount ?? 0;
  }

  // Rotated refresh tokens are kept briefly (ROTATION_GRACE_SECONDS) so
  // concurrent refreshes are tolerated, then become dead weight long before
  // their 30-day expires_at. Purge them once well past the grace window —
  // between runs they are harmless: a rotated token presented after the
  // window is rejected whether or not its row still exists.
  const { rowCount: rotatedDeleted } = await pool.query(
    `DELETE FROM homectl_auth.sessions
      WHERE rotated_at IS NOT NULL AND rotated_at < NOW() - INTERVAL '1 hour'`,
  );
  totalDeleted += rotatedDeleted ?? 0;

  // Activity events power the admin statistics; keep them for the configured
  // retention window (ACTIVITY_RETENTION_DAYS, default 90) and prune the rest.
  totalDeleted += await deleteEventsOlderThanDays(getActivityRetentionDays());

  if (totalDeleted > 0) {
    logger.info({ totalDeleted }, 'Cleanup job: deleted expired rows');
  }
}

export function startCleanupJob(): void {
  if (_interval) return; // already running
  _interval = setInterval(async () => {
    try {
      await runCleanup();
    } catch (err) {
      logger.error(err, 'Cleanup job failed');
    }
  }, CLEANUP_INTERVAL_MS);

  // Don't hold the process open for this timer
  _interval.unref();

  logger.info('Cleanup job started (interval: 1 day)');
}

export function stopCleanupJob(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
