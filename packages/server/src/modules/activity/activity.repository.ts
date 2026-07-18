import { getPool } from '../../db';

export type ActivityEventType = 'login' | 'sso_login' | 'refresh';

/** How long a refresh row "covers" — further refreshes within the window are
 *  not recorded, so an active session writes at most one row per hour instead
 *  of one per access-token lifetime. */
export const REFRESH_COALESCE_WINDOW = '1 hour';

// ── Writes ─────────────────────────────────────────────────────────────────

export async function insertEvent(
  userId: string,
  clientId: string,
  eventType: ActivityEventType,
): Promise<void> {
  await getPool().query(
    `INSERT INTO homectl_auth.activity_events (user_id, client_id, event_type)
     VALUES ($1, $2, $3)`,
    [userId, clientId, eventType],
  );
}

/** Insert a 'refresh' event unless one already exists for this user+app within
 *  the coalesce window. */
export async function insertRefreshEventCoalesced(
  userId: string,
  clientId: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO homectl_auth.activity_events (user_id, client_id, event_type)
     SELECT $1, $2, 'refresh'
     WHERE NOT EXISTS (
       SELECT 1 FROM homectl_auth.activity_events
        WHERE user_id = $1 AND client_id = $2 AND event_type = 'refresh'
          AND occurred_at > NOW() - INTERVAL '${REFRESH_COALESCE_WINDOW}'
     )`,
    [userId, clientId],
  );
}

export async function deleteEventsOlderThanDays(days: number): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM homectl_auth.activity_events
      WHERE occurred_at < NOW() - make_interval(days => $1)`,
    [days],
  );
  return rowCount ?? 0;
}

// ── Aggregates (admin statistics) ──────────────────────────────────────────

export type OverviewCounts = {
  totalUsers: number;
  neverLoggedIn: number;
  newUsers30d: number;
  activeUsers1d: number;
  activeUsers7d: number;
  activeUsers30d: number;
};

export async function getOverviewCounts(): Promise<OverviewCounts> {
  const { rows } = await getPool().query<Record<string, unknown>>(`
    SELECT
      (SELECT COUNT(*) FROM homectl_auth.users)                            AS total_users,
      (SELECT COUNT(*) FROM homectl_auth.users
        WHERE last_login_at IS NULL)                                       AS never_logged_in,
      (SELECT COUNT(*) FROM homectl_auth.users
        WHERE created_at > NOW() - INTERVAL '30 days')                     AS new_users_30d,
      (SELECT COUNT(DISTINCT user_id) FROM homectl_auth.activity_events
        WHERE occurred_at > NOW() - INTERVAL '1 day')                      AS active_1d,
      (SELECT COUNT(DISTINCT user_id) FROM homectl_auth.activity_events
        WHERE occurred_at > NOW() - INTERVAL '7 days')                     AS active_7d,
      (SELECT COUNT(DISTINCT user_id) FROM homectl_auth.activity_events
        WHERE occurred_at > NOW() - INTERVAL '30 days')                    AS active_30d
  `);
  const r = rows[0]!;
  return {
    totalUsers: Number(r['total_users']),
    neverLoggedIn: Number(r['never_logged_in']),
    newUsers30d: Number(r['new_users_30d']),
    activeUsers1d: Number(r['active_1d']),
    activeUsers7d: Number(r['active_7d']),
    activeUsers30d: Number(r['active_30d']),
  };
}

export type SessionCount = { clientId: string; sessions: number; users: number };

/** Live (non-expired, non-rotated) refresh sessions grouped by app. */
export async function getActiveSessionCounts(): Promise<SessionCount[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(`
    SELECT client_id, COUNT(*) AS sessions, COUNT(DISTINCT user_id) AS users
    FROM homectl_auth.sessions
    WHERE expires_at > NOW() AND rotated_at IS NULL
    GROUP BY client_id
    ORDER BY client_id
  `);
  return rows.map((r) => ({
    clientId: r['client_id'] as string,
    sessions: Number(r['sessions']),
    users: Number(r['users']),
  }));
}

export type DailyActivity = { date: string; logins: number; activeUsers: number };

/** One row per calendar day (today inclusive, going back `days`), zero-filled. */
export async function getDailyActivity(days: number): Promise<DailyActivity[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT to_char(d.day, 'YYYY-MM-DD')       AS date,
            COALESCE(e.logins, 0)              AS logins,
            COALESCE(e.active_users, 0)        AS active_users
     FROM generate_series(
            CURRENT_DATE - ($1::int - 1), CURRENT_DATE, INTERVAL '1 day'
          ) AS d(day)
     LEFT JOIN (
       SELECT occurred_at::date AS day,
              COUNT(*) FILTER (WHERE event_type IN ('login', 'sso_login')) AS logins,
              COUNT(DISTINCT user_id)                                      AS active_users
       FROM homectl_auth.activity_events
       WHERE occurred_at >= CURRENT_DATE - ($1::int - 1)
       GROUP BY 1
     ) e ON e.day = d.day
     ORDER BY d.day`,
    [days],
  );
  return rows.map((r) => ({
    date: r['date'] as string,
    logins: Number(r['logins']),
    activeUsers: Number(r['active_users']),
  }));
}

export type AppActivity = {
  clientId: string;
  logins: number;
  activeUsers: number;
  lastUsedAt: Date | null;
};

/** Per-app usage within the last `days` days. Apps with no events are absent. */
export async function getAppActivity(days: number): Promise<AppActivity[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT client_id,
            COUNT(*) FILTER (WHERE event_type IN ('login', 'sso_login')) AS logins,
            COUNT(DISTINCT user_id)                                      AS active_users,
            MAX(occurred_at)                                             AS last_used_at
     FROM homectl_auth.activity_events
     WHERE occurred_at > NOW() - make_interval(days => $1)
     GROUP BY client_id`,
    [days],
  );
  return rows.map((r) => ({
    clientId: r['client_id'] as string,
    logins: Number(r['logins']),
    activeUsers: Number(r['active_users']),
    lastUsedAt: (r['last_used_at'] as Date | null) ?? null,
  }));
}

/** Users granted access, grouped by app (independent of activity). */
export async function getGrantedUserCounts(): Promise<Map<string, number>> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT app_id, COUNT(*) AS users FROM homectl_auth.app_access GROUP BY app_id`,
  );
  return new Map(rows.map((r) => [r['app_id'] as string, Number(r['users'])]));
}

export type UserAppActivity = {
  clientId: string;
  logins: number;
  activeDays: number;
  lastUsedAt: Date;
};

export async function getUserAppActivity(
  userId: string,
  days: number,
): Promise<UserAppActivity[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT client_id,
            COUNT(*) FILTER (WHERE event_type IN ('login', 'sso_login')) AS logins,
            COUNT(DISTINCT occurred_at::date)                            AS active_days,
            MAX(occurred_at)                                             AS last_used_at
     FROM homectl_auth.activity_events
     WHERE user_id = $1 AND occurred_at > NOW() - make_interval(days => $2)
     GROUP BY client_id
     ORDER BY last_used_at DESC`,
    [userId, days],
  );
  return rows.map((r) => ({
    clientId: r['client_id'] as string,
    logins: Number(r['logins']),
    activeDays: Number(r['active_days']),
    lastUsedAt: r['last_used_at'] as Date,
  }));
}

export type UserEvent = {
  clientId: string;
  eventType: ActivityEventType;
  occurredAt: Date;
};

export async function getRecentUserEvents(
  userId: string,
  limit: number,
): Promise<UserEvent[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT client_id, event_type, occurred_at
     FROM homectl_auth.activity_events
     WHERE user_id = $1
     ORDER BY occurred_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    clientId: r['client_id'] as string,
    eventType: r['event_type'] as ActivityEventType,
    occurredAt: r['occurred_at'] as Date,
  }));
}
