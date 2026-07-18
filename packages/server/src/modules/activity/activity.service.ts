/**
 * Activity tracking — records auth events into homectl_auth.activity_events
 * for the admin statistics pages.
 *
 * Recording is strictly best-effort: a statistics insert must never fail a
 * login or a token refresh, so every recorder swallows and logs errors
 * instead of throwing.
 *
 * Retention is configurable via ACTIVITY_RETENTION_DAYS (default 365); the
 * hourly cleanup job prunes older rows.
 */

import { logger } from '../../logger';
import {
  insertEvent,
  insertRefreshEventCoalesced,
  type ActivityEventType,
} from './activity.repository';

const DEFAULT_RETENTION_DAYS = 365;

export function getActivityRetentionDays(): number {
  const raw = process.env['ACTIVITY_RETENTION_DAYS'];
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    logger.warn(
      { value: raw },
      `Invalid ACTIVITY_RETENTION_DAYS — falling back to ${DEFAULT_RETENTION_DAYS}`,
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

/** Record a login ('login' for the credential form, 'sso_login' for the SSO
 *  cookie short-circuit). Never throws. */
export async function recordLogin(
  userId: string,
  clientId: string,
  eventType: Extract<ActivityEventType, 'login' | 'sso_login'>,
): Promise<void> {
  try {
    await insertEvent(userId, clientId, eventType);
  } catch (err) {
    logger.error({ err, userId, clientId, eventType }, 'Failed to record login event');
  }
}

/** Record refresh activity, coalesced to at most one row per user+app+hour.
 *  Never throws. */
export async function recordRefresh(userId: string, clientId: string): Promise<void> {
  try {
    await insertRefreshEventCoalesced(userId, clientId);
  } catch (err) {
    logger.error({ err, userId, clientId }, 'Failed to record refresh event');
  }
}
