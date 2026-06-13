import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleAlert } from 'lucide-react';
import { CenteredLayout } from '@/components/centered-layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authErrorMessage } from '@/lib/auth-messages';

/**
 * Invite redemption: choose a username + password to activate the account.
 * Native POST to /invite (server redeems the token, then redirects to
 * /?invited=1). We add a client-side password-match guard before submit.
 */
export function InvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const serverError = authErrorMessage(params.get('error'));
  const [localError, setLocalError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const form = e.currentTarget;
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;
    const confirm = (form.elements.namedItem('confirm') as HTMLInputElement).value;
    if (password !== confirm) {
      e.preventDefault();
      setLocalError('Passwords do not match.');
    }
  };

  const error = localError ?? serverError;

  return (
    <CenteredLayout>
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl">Activate your account</CardTitle>
          <CardDescription>Choose a username and password to get started.</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <CircleAlert className="size-4" aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form method="post" action="/invite" className="space-y-4" onSubmit={onSubmit}>
            <input type="hidden" name="token" value={token} />
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" name="username" autoComplete="username" autoFocus required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
              <p className="text-xs text-muted-foreground">At least 8 characters.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            <Button type="submit" className="w-full">
              Create account
            </Button>
          </form>
        </CardContent>
      </Card>
    </CenteredLayout>
  );
}
