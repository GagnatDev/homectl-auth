import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleAlert } from 'lucide-react';
import { CenteredLayout } from '@/components/centered-layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchAppName } from '@/lib/api';
import { authErrorMessage } from '@/lib/auth-messages';

/**
 * OAuth login. The form is a *native* POST to /login so the server's
 * cross-origin 302 (governed by the CSP form-action directive) is preserved —
 * we deliberately do not fetch/submit via JS. Context comes from the query
 * string the server kept on the URL.
 */
export function LoginPage() {
  const [params] = useSearchParams();
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const state = params.get('state') ?? '';
  const error = authErrorMessage(params.get('error'));

  const [appName, setAppName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (clientId) {
      void fetchAppName(clientId).then((name) => {
        if (active) setAppName(name);
      });
    }
    return () => {
      active = false;
    };
  }, [clientId]);

  return (
    <CenteredLayout>
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>
            {appName ? `Continue to ${appName}` : 'Continue to your application'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <CircleAlert className="size-4" aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form method="post" action="/login" className="space-y-4">
            <input type="hidden" name="client_id" value={clientId} />
            <input type="hidden" name="redirect_uri" value={redirectUri} />
            <input type="hidden" name="state" value={state} />
            <div className="space-y-2">
              <Label htmlFor="username">Username or email</Label>
              <Input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </CenteredLayout>
  );
}
