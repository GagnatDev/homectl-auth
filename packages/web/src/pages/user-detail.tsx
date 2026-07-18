import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CircleAlert, Copy, KeyRound, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AdminLayout } from '@/components/admin-layout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  api,
  ApiError,
  type ActivityEventType,
  type AppInfo,
  type UserActivity,
  type UserDetail,
} from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export function UserDetailPage() {
  const { id = '' } = useParams();
  const [user, setUser] = useState<UserDetail | null>(null);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reportError = useCallback((err: unknown) => {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return;
    const message = err instanceof Error ? err.message : 'Something went wrong.';
    setError(message);
    toast.error(message);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      setUser(await api.getUser(id));
    } catch (err) {
      reportError(err);
    }
  }, [id, reportError]);

  useEffect(() => {
    void refreshUser();
    api
      .listApps()
      .then(setApps)
      .catch(reportError);
  }, [refreshUser, reportError]);

  if (error && !user) {
    return (
      <AdminLayout>
        <BackLink />
        <Alert variant="destructive">
          <CircleAlert className="size-4" aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </AdminLayout>
    );
  }

  if (!user) {
    return (
      <AdminLayout>
        <BackLink />
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <BackLink />

      <div className="mb-6">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
          {user.email}
          {user.isAdmin && <Badge variant="secondary">admin</Badge>}
        </h1>
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <div className="flex gap-1">
            <dt>Username:</dt>
            <dd className="font-medium text-foreground">{user.username}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Created:</dt>
            <dd className="font-medium text-foreground">{formatDateTime(user.createdAt)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Last login:</dt>
            <dd className="font-medium text-foreground">{formatDateTime(user.lastLoginAt)}</dd>
          </div>
        </dl>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <AppAccessCard user={user} apps={apps} onChange={refreshUser} reportError={reportError} />
        <PasswordResetCard userId={user.id} reportError={reportError} />
        <ActivityCard userId={user.id} reportError={reportError} />
      </div>
    </AdminLayout>
  );
}

function BackLink() {
  return (
    <Link
      to="/admin"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back to users
    </Link>
  );
}

function AppAccessCard({
  user,
  apps,
  onChange,
  reportError,
}: {
  user: UserDetail;
  apps: AppInfo[];
  onChange: () => Promise<void>;
  reportError: (err: unknown) => void;
}) {
  const appName = (appId: string) => apps.find((a) => a.id === appId)?.name ?? appId;

  const revoke = async (appId: string) => {
    try {
      await api.revokeAccess(user.id, appId);
      toast.success(`Revoked access to ${appName(appId)}`);
      await onChange();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">App access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {user.appAccess.length === 0 ? (
          <p className="text-sm text-muted-foreground">No app access granted yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {user.appAccess.map((a) => (
              <li key={a.appId} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{appName(a.appId)}</div>
                  <div className="text-sm text-muted-foreground">
                    Role: <span className="font-medium">{a.role}</span>
                  </div>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="size-4" aria-hidden />
                      <span className="sr-only sm:not-sr-only">Revoke</span>
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke access?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes {user.email}’s access to {appName(a.appId)}. They will no
                        longer be able to sign in to it.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => void revoke(a.appId)}
                      >
                        Revoke
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        )}

        <GrantForm user={user} apps={apps} onGranted={onChange} reportError={reportError} />
      </CardContent>
    </Card>
  );
}

function GrantForm({
  user,
  apps,
  onGranted,
  reportError,
}: {
  user: UserDetail;
  apps: AppInfo[];
  onGranted: () => Promise<void>;
  reportError: (err: unknown) => void;
}) {
  const [appId, setAppId] = useState('');
  const [role, setRole] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const selectedApp = apps.find((a) => a.id === appId);
  const roles = selectedApp?.roles ?? [];

  const onAppChange = (value: string) => {
    setAppId(value);
    const first = apps.find((a) => a.id === value)?.roles[0]?.name ?? '';
    setRole(first);
  };

  const grant = async () => {
    if (!appId || !role) return;
    setSubmitting(true);
    try {
      await api.grantAccess(user.id, appId, role);
      toast.success(`Granted ${role} on ${selectedApp?.name ?? appId}`);
      setAppId('');
      setRole('');
      await onGranted();
    } catch (err) {
      reportError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">Grant access</h3>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="grant-app">App</Label>
          <Select value={appId} onValueChange={onAppChange}>
            <SelectTrigger id="grant-app">
              <SelectValue placeholder="Select app" />
            </SelectTrigger>
            <SelectContent>
              {apps.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="grant-role">Role</Label>
          <Select value={role} onValueChange={setRole} disabled={!selectedApp}>
            <SelectTrigger id="grant-role">
              <SelectValue placeholder="Select role" />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.name} value={r.name}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={grant} disabled={!appId || !role || submitting}>
          Grant
        </Button>
      </div>
    </div>
  );
}

const EVENT_LABELS: Record<ActivityEventType, string> = {
  login: 'Login',
  sso_login: 'SSO login',
  refresh: 'Active',
};

function ActivityCard({
  userId,
  reportError,
}: {
  userId: string;
  reportError: (err: unknown) => void;
}) {
  const [activity, setActivity] = useState<UserActivity | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getUserActivity(userId)
      .then((data) => active && setActivity(data))
      .catch(reportError);
    return () => {
      active = false;
    };
  }, [userId, reportError]);

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-lg">Activity (last 30 days)</CardTitle>
      </CardHeader>
      <CardContent>
        {!activity ? (
          <Skeleton className="h-24 w-full rounded-md" />
        ) : activity.apps.length === 0 && activity.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recorded activity yet. Usage shows up here once this user signs in.
          </p>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-medium">Apps used</h3>
              {activity.apps.length === 0 ? (
                <p className="text-sm text-muted-foreground">No app usage in this period.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {activity.apps.map((a) => (
                    <li key={a.clientId} className="p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate font-medium">{a.name}</span>
                        <span className="shrink-0 text-sm text-muted-foreground">
                          {a.logins} {a.logins === 1 ? 'login' : 'logins'} · active{' '}
                          {a.activeDays} {a.activeDays === 1 ? 'day' : 'days'}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        Last used {formatDateTime(a.lastUsedAt)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">Recent events</h3>
              {activity.recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events recorded.</p>
              ) : (
                <ul className="divide-y rounded-md border text-sm">
                  {activity.recent.map((e, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 p-2.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <Badge variant="secondary" className="shrink-0 font-normal">
                          {EVENT_LABELS[e.eventType]}
                        </Badge>
                        <span className="truncate text-muted-foreground">{e.name}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDateTime(e.occurredAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PasswordResetCard({
  userId,
  reportError,
}: {
  userId: string;
  reportError: (err: unknown) => void;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const generate = async () => {
    setLoading(true);
    try {
      const result = await api.createPasswordReset(userId);
      setLink(`${window.location.origin}${result.link}`);
    } catch (err) {
      reportError(err);
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Reset link copied to clipboard');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Password reset</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Generate a one-time link the user can use to set a new password.
        </p>
        <Button variant="outline" onClick={generate} disabled={loading}>
          <KeyRound className="size-4" aria-hidden />
          {loading ? 'Generating…' : 'Generate reset link'}
        </Button>

        <div aria-live="polite">
          {link && (
            <div className="space-y-2 rounded-md border bg-muted/40 p-3">
              <Label htmlFor="reset-link" className="text-xs text-muted-foreground">
                Reset link
              </Label>
              <div className="flex items-center gap-2">
                <input
                  id="reset-link"
                  readOnly
                  value={link}
                  className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button variant="outline" size="icon" onClick={copy} aria-label="Copy reset link">
                  <Copy className="size-4" aria-hidden />
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
