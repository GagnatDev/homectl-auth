import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleAlert, Github } from 'lucide-react';
import { CenteredLayout } from '@/components/centered-layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { fetchAdminLoginUrl } from '@/lib/api';

const ADMIN_LOGIN_ERRORS: Record<string, string> = {
  invalid_state: 'Your login session expired. Please try again.',
  not_authorized: 'This GitHub account is not authorized for admin access.',
  github_failed: 'GitHub login failed. Please try again.',
};

export function AdminLoginPage() {
  const [params] = useSearchParams();
  const paramError = params.get('error');
  const [error, setError] = useState<string | null>(
    paramError ? (ADMIN_LOGIN_ERRORS[paramError] ?? 'Login failed. Please try again.') : null,
  );
  const [loading, setLoading] = useState(false);

  const signIn = async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetches a fresh authorize URL and sets the CSRF state cookie, then hands
      // off to GitHub for the top-level OAuth navigation.
      const url = await fetchAdminLoginUrl();
      window.location.assign(url);
    } catch {
      setError('Could not start GitHub login. Please try again.');
      setLoading(false);
    }
  };

  return (
    <CenteredLayout>
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl">Admin sign in</CardTitle>
          <CardDescription>Sign in with your authorized GitHub account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <CircleAlert className="size-4" aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button className="w-full" onClick={signIn} disabled={loading}>
            <Github className="size-4" aria-hidden />
            {loading ? 'Redirecting…' : 'Sign in with GitHub'}
          </Button>
        </CardContent>
      </Card>
    </CenteredLayout>
  );
}
