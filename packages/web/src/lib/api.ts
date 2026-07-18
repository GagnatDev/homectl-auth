/**
 * Typed client for the admin JSON API (/admin/api/*) and the public app-info
 * endpoint. All admin calls send the httpOnly `homectl_admin_token` cookie via
 * `credentials: 'include'`; a 401/403 means the admin session is missing or
 * expired, so we bounce to the GitHub login page.
 */

export type AppAccess = { appId: string; role: string };

export type UserSummary = {
  id: string;
  email: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  appAccess: AppAccess[];
};

export type UserDetail = UserSummary;

export type AppRole = { name: string; rank: number };
export type AppInfo = { id: string; name: string; roles: AppRole[] };

// ── Statistics ──────────────────────────────────────────────────────────────

export type StatsOverview = {
  totalUsers: number;
  neverLoggedIn: number;
  newUsers30d: number;
  activeUsers: { day: number; week: number; month: number };
  activeSessions: { clientId: string; name: string; sessions: number; users: number }[];
  totalActiveSessions: number;
};

export type DailyActivity = { date: string; logins: number; activeUsers: number };
export type StatsActivity = { days: number; series: DailyActivity[] };

export type AppUsage = {
  clientId: string;
  name: string;
  configured: boolean;
  grantedUsers: number;
  logins: number;
  activeUsers: number;
  lastUsedAt: string | null;
};
export type StatsApps = { days: number; apps: AppUsage[] };

export type ActivityEventType = 'login' | 'sso_login' | 'refresh';

export type UserActivity = {
  days: number;
  apps: {
    clientId: string;
    name: string;
    logins: number;
    activeDays: number;
    lastUsedAt: string;
  }[];
  recent: {
    clientId: string;
    name: string;
    eventType: ActivityEventType;
    occurredAt: string;
  }[];
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    ...init,
  });

  if (res.status === 401 || res.status === 403) {
    // Session missing/expired — hand off to the GitHub login page.
    window.location.assign('/admin/login');
    throw new ApiError(res.status, 'Not authenticated');
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body — keep the default message
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listUsers: () => request<UserSummary[]>('/admin/api/users'),

  getUser: (id: string) => request<UserDetail>(`/admin/api/users/${id}`),

  listApps: () => request<AppInfo[]>('/admin/api/apps'),

  grantAccess: (userId: string, appId: string, role: string) =>
    request<AppAccess>(`/admin/api/users/${userId}/access`, {
      method: 'POST',
      body: JSON.stringify({ appId, role }),
    }),

  revokeAccess: (userId: string, appId: string) =>
    request<void>(`/admin/api/users/${userId}/access/${encodeURIComponent(appId)}`, {
      method: 'DELETE',
    }),

  createInvite: (email: string, appGrants: AppAccess[]) =>
    request<{ token: string; link: string }>('/admin/api/invites', {
      method: 'POST',
      body: JSON.stringify({ email, appGrants }),
    }),

  createPasswordReset: (userId: string) =>
    request<{ token: string; link: string }>(`/admin/api/users/${userId}/password-reset`, {
      method: 'POST',
    }),

  getStatsOverview: () => request<StatsOverview>('/admin/api/stats/overview'),

  getStatsActivity: (days: number) =>
    request<StatsActivity>(`/admin/api/stats/activity?days=${days}`),

  getStatsApps: (days: number) => request<StatsApps>(`/admin/api/stats/apps?days=${days}`),

  getUserActivity: (userId: string, days = 30) =>
    request<UserActivity>(`/admin/api/users/${userId}/activity?days=${days}`),
};

export type PublicAppInfo = { id: string; name: string; landingUrl: string | null };

/** Public: app display info (name + landing URL) for the SPA's public pages. */
export async function fetchPublicApp(clientId: string): Promise<PublicAppInfo | null> {
  try {
    const res = await fetch(`/api/apps/${encodeURIComponent(clientId)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicAppInfo;
  } catch {
    return null;
  }
}

/** Public: the login page fetches an app's display name for its heading. */
export async function fetchAppName(clientId: string): Promise<string | null> {
  return (await fetchPublicApp(clientId))?.name ?? null;
}

/** Public: mint the GitHub authorize URL (also sets the CSRF state cookie). */
export async function fetchAdminLoginUrl(): Promise<string> {
  const res = await fetch('/api/admin-login', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new ApiError(res.status, 'Could not start GitHub login');
  const body = (await res.json()) as { url: string };
  return body.url;
}
