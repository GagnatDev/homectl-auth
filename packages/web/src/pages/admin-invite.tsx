import { useEffect, useState } from 'react';
import { CircleAlert, Copy, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AdminLayout } from '@/components/admin-layout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, ApiError, type AppInfo } from '@/lib/api';

type GrantRow = { appId: string; role: string };

export function AdminInvitePage() {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [email, setEmail] = useState('');
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    api
      .listApps()
      .then(setApps)
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return;
        setError(err instanceof Error ? err.message : 'Could not load apps.');
      });
  }, []);

  const addGrant = () => {
    const app = apps[0];
    if (!app) return;
    setGrants((g) => [...g, { appId: app.id, role: app.roles[0]?.name ?? '' }]);
  };

  const updateGrant = (index: number, next: Partial<GrantRow>) => {
    setGrants((g) => g.map((row, i) => (i === index ? { ...row, ...next } : row)));
  };

  const removeGrant = (index: number) => {
    setGrants((g) => g.filter((_, i) => i !== index));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setLink(null);
    try {
      const result = await api.createInvite(email.trim(), grants);
      setLink(`${window.location.origin}${result.link}`);
      toast.success('Invite created');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return;
      const message = err instanceof Error ? err.message : 'Could not create invite.';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Invite link copied to clipboard');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  return (
    <AdminLayout>
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Invite a user</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Create an invite link granting access to one or more apps.
        </p>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">New invite</CardTitle>
          </CardHeader>
          <CardContent>
            {error && (
              <Alert variant="destructive" className="mb-4">
                <CircleAlert className="size-4" aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <form className="space-y-6" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="off"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">App grants</legend>
                {grants.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No grants yet — the user will have no app access until granted.
                  </p>
                )}
                {grants.map((row, i) => {
                  const roles = apps.find((a) => a.id === row.appId)?.roles ?? [];
                  return (
                    <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Select
                        value={row.appId}
                        onValueChange={(appId) => {
                          const firstRole = apps.find((a) => a.id === appId)?.roles[0]?.name ?? '';
                          updateGrant(i, { appId, role: firstRole });
                        }}
                      >
                        <SelectTrigger className="flex-1" aria-label="App">
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
                      <Select value={row.role} onValueChange={(role) => updateGrant(i, { role })}>
                        <SelectTrigger className="flex-1" aria-label="Role">
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
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => removeGrant(i)}
                        aria-label="Remove grant"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addGrant}
                  disabled={apps.length === 0}
                >
                  <Plus className="size-4" aria-hidden />
                  Add app grant
                </Button>
              </fieldset>

              <Button type="submit" disabled={submitting || !email.trim()}>
                {submitting ? 'Creating…' : 'Create invite'}
              </Button>
            </form>

            <div aria-live="polite">
              {link && (
                <div className="mt-6 space-y-2 rounded-md border bg-muted/40 p-3">
                  <Label htmlFor="invite-link" className="text-xs text-muted-foreground">
                    Invite link — share it with the user
                  </Label>
                  <div className="flex items-center gap-2">
                    <input
                      id="invite-link"
                      readOnly
                      value={link}
                      className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={copy}
                      aria-label="Copy invite link"
                    >
                      <Copy className="size-4" aria-hidden />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
