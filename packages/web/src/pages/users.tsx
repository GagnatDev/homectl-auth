import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, CircleAlert, UserPlus } from 'lucide-react';
import { AdminLayout } from '@/components/admin-layout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, ApiError, type UserSummary } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export function UsersPage() {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .listUsers()
      .then((data) => active && setUsers(data))
      .catch((err) => {
        // 401/403 already redirected inside the api client; surface the rest.
        if (active && err instanceof ApiError && err.status !== 401 && err.status !== 403) {
          setError(err.message);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <AdminLayout>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">
            {users ? `${users.length} ${users.length === 1 ? 'user' : 'users'}` : 'Loading…'}
          </p>
        </div>
        <Button asChild>
          <Link to="/admin/invite">
            <UserPlus className="size-4" aria-hidden />
            <span className="hidden sm:inline">Invite user</span>
            <span className="sm:hidden">Invite</span>
          </Link>
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <CircleAlert className="size-4" aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!users && !error && <UsersSkeleton />}

      {users && users.length === 0 && (
        <p className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No users yet. Invite someone to get started.
        </p>
      )}

      {users && users.length > 0 && (
        <>
          {/* Desktop / tablet: table */}
          <div className="hidden rounded-lg border bg-card sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Apps</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id} className="cursor-pointer">
                    <TableCell className="font-medium">
                      <Link to={`/admin/users/${u.id}`} className="block hover:underline">
                        {u.email}
                        {u.isAdmin && (
                          <Badge variant="secondary" className="ml-2 align-middle">
                            admin
                          </Badge>
                        )}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{u.username}</TableCell>
                    <TableCell className="text-muted-foreground">{u.appAccess.length}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(u.lastLoginAt)}
                    </TableCell>
                    <TableCell>
                      <Link to={`/admin/users/${u.id}`} aria-label={`Open ${u.email}`}>
                        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile: stacked cards */}
          <ul className="space-y-3 sm:hidden">
            {users.map((u) => (
              <li key={u.id}>
                <Link
                  to={`/admin/users/${u.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border bg-card p-4"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{u.email}</span>
                      {u.isAdmin && <Badge variant="secondary">admin</Badge>}
                    </div>
                    <div className="mt-1 truncate text-sm text-muted-foreground">{u.username}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {u.appAccess.length} {u.appAccess.length === 1 ? 'app' : 'apps'} · last login{' '}
                      {formatDateTime(u.lastLoginAt)}
                    </div>
                  </div>
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </AdminLayout>
  );
}

function UsersSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}
