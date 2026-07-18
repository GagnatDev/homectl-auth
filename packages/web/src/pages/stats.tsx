import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { AdminLayout } from '@/components/admin-layout';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { BarList, ChartCard, StatTile, TimeSeriesChart } from '@/components/charts';
import {
  api,
  ApiError,
  type StatsActivity,
  type StatsApps,
  type StatsOverview,
} from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const RANGE_PRESETS = [7, 30, 90] as const;

export function StatsPage() {
  const [days, setDays] = useState<number>(30);
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [activity, setActivity] = useState<StatsActivity | null>(null);
  const [apps, setApps] = useState<StatsApps | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reportError = (err: unknown) => {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return;
    setError(err instanceof Error ? err.message : 'Something went wrong.');
  };

  useEffect(() => {
    api.getStatsOverview().then(setOverview).catch(reportError);
  }, []);

  // Range changes refetch the time-scoped data; previous renders are kept on
  // screen until the new slice arrives (no skeleton flash).
  useEffect(() => {
    let active = true;
    api
      .getStatsActivity(days)
      .then((d) => active && setActivity(d))
      .catch(reportError);
    api
      .getStatsApps(days)
      .then((d) => active && setApps(d))
      .catch(reportError);
    return () => {
      active = false;
    };
  }, [days]);

  const loading = !overview && !error;

  return (
    <AdminLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Statistics</h1>
        <p className="text-sm text-muted-foreground">
          Sign-ins and app usage across all users.
        </p>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <CircleAlert className="size-4" aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && <StatsSkeleton />}

      {overview && (
        <div className="space-y-6">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Total users" value={overview.totalUsers} />
            <StatTile label="Active last 7 days" value={overview.activeUsers.week} />
            <StatTile label="Active last 30 days" value={overview.activeUsers.month} />
            <StatTile
              label="Sessions now"
              value={overview.totalActiveSessions}
              hint={
                overview.activeSessions.length > 0
                  ? overview.activeSessions.map((s) => `${s.name}: ${s.sessions}`).join(' · ')
                  : undefined
              }
            />
            <StatTile label="Never logged in" value={overview.neverLoggedIn} />
            <StatTile label="New users (30 days)" value={overview.newUsers30d} />
          </div>

          {/* Range filter — scopes the charts and the app table below */}
          <div className="flex items-center gap-1" role="group" aria-label="Date range">
            {RANGE_PRESETS.map((preset) => (
              <Button
                key={preset}
                variant={days === preset ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setDays(preset)}
                aria-pressed={days === preset}
              >
                Last {preset} days
              </Button>
            ))}
          </div>

          {activity && (
            <ChartCard title="Daily activity">
              {activity.series.every((d) => d.logins === 0 && d.activeUsers === 0) ? (
                <EmptyNote />
              ) : (
                <TimeSeriesChart
                  ariaLabel={`Active users and logins per day, last ${days} days`}
                  data={activity.series}
                  series={[
                    { key: 'activeUsers', label: 'Active users', color: 'var(--chart-1)' },
                    { key: 'logins', label: 'Logins', color: 'var(--chart-2)' },
                  ]}
                />
              )}
            </ChartCard>
          )}

          {apps && (
            <div className="grid gap-6 lg:grid-cols-2">
              <ChartCard title="Logins per app">
                {apps.apps.every((a) => a.logins === 0) ? (
                  <EmptyNote />
                ) : (
                  <BarList
                    items={[...apps.apps]
                      .sort((a, b) => b.logins - a.logins)
                      .map((a) => ({
                        label: a.name,
                        value: a.logins,
                        detail:
                          a.activeUsers > 0
                            ? `${a.activeUsers} ${a.activeUsers === 1 ? 'user' : 'users'}`
                            : undefined,
                      }))}
                  />
                )}
              </ChartCard>

              <ChartCard title="App usage">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>App</TableHead>
                      <TableHead className="text-right">Access</TableHead>
                      <TableHead className="text-right">Active</TableHead>
                      <TableHead>Last used</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {apps.apps.map((a) => (
                      <TableRow key={a.clientId}>
                        <TableCell className="font-medium">
                          {a.name}
                          {!a.configured && (
                            <span className="ml-2 text-xs text-muted-foreground">(removed)</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {a.grantedUsers}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {a.activeUsers}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(a.lastUsedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ChartCard>
            </div>
          )}
        </div>
      )}
    </AdminLayout>
  );
}

function EmptyNote() {
  return (
    <p className="py-8 text-center text-sm text-muted-foreground">
      No activity recorded in this period yet. Statistics build up as people sign in and use
      their apps.
    </p>
  );
}

function StatsSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-lg" />
    </div>
  );
}
