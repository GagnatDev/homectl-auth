import { getPool } from '../../db';

export type User = {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
};

type CreateUserInput = {
  email: string;
  username: string;
  passwordHash: string;
  isAdmin?: boolean;
};

// ── Row mapper ─────────────────────────────────────────────────────────────

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row['id'] as string,
    email: row['email'] as string,
    username: row['username'] as string,
    passwordHash: row['password_hash'] as string,
    isAdmin: row['is_admin'] as boolean,
    createdAt: row['created_at'] as Date,
    lastLoginAt: (row['last_login_at'] as Date | null) ?? null,
  };
}

// ── Queries ────────────────────────────────────────────────────────────────

export async function createUser(input: CreateUserInput): Promise<User> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `INSERT INTO homectl_auth.users (email, username, password_hash, is_admin)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.email, input.username, input.passwordHash, input.isAdmin ?? false],
  );
  return rowToUser(rows[0]!);
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    'SELECT * FROM homectl_auth.users WHERE email = $1',
    [email],
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    'SELECT * FROM homectl_auth.users WHERE id = $1',
    [id],
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function updateLastLogin(userId: string): Promise<void> {
  await getPool().query(
    'UPDATE homectl_auth.users SET last_login_at = NOW() WHERE id = $1',
    [userId],
  );
}

export async function updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
  await getPool().query(
    'UPDATE homectl_auth.users SET password_hash = $1 WHERE id = $2',
    [passwordHash, userId],
  );
}

export async function anyAdminExists(): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM homectl_auth.users WHERE is_admin = TRUE) AS exists',
  );
  return rows[0]!.exists;
}
