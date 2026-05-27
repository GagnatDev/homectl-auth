import { getPool } from '../../db';

export type AppAccess = {
  userId: string;
  appId: string;
  role: string;
  grantedAt: Date;
};

function rowToAppAccess(row: Record<string, unknown>): AppAccess {
  return {
    userId: row['user_id'] as string,
    appId: row['app_id'] as string,
    role: row['role'] as string,
    grantedAt: row['granted_at'] as Date,
  };
}

export async function grantAccess(userId: string, appId: string, role: string): Promise<AppAccess> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `INSERT INTO homectl_auth.app_access (user_id, app_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, app_id) DO UPDATE SET role = EXCLUDED.role, granted_at = NOW()
     RETURNING *`,
    [userId, appId, role],
  );
  return rowToAppAccess(rows[0]!);
}

export async function revokeAccess(userId: string, appId: string): Promise<void> {
  await getPool().query(
    'DELETE FROM homectl_auth.app_access WHERE user_id = $1 AND app_id = $2',
    [userId, appId],
  );
}

export async function getAccessForUser(userId: string): Promise<AppAccess[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    'SELECT * FROM homectl_auth.app_access WHERE user_id = $1',
    [userId],
  );
  return rows.map(rowToAppAccess);
}

export async function getAccessForApp(appId: string): Promise<AppAccess[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    'SELECT * FROM homectl_auth.app_access WHERE app_id = $1',
    [appId],
  );
  return rows.map(rowToAppAccess);
}

export async function findAccess(userId: string, appId: string): Promise<AppAccess | null> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    'SELECT * FROM homectl_auth.app_access WHERE user_id = $1 AND app_id = $2',
    [userId, appId],
  );
  return rows[0] ? rowToAppAccess(rows[0]) : null;
}

export async function hasAccess(userId: string, appId: string): Promise<boolean> {
  const access = await findAccess(userId, appId);
  return access !== null;
}
