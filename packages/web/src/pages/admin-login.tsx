import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleAlert } from 'lucide-react';
import { CenteredLayout } from '@/components/centered-layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { fetchAdminLoginUrl } from '@/lib/api';

// lucide-react 1.x dropped brand marks. This is the same stroke icon the
// admin login button used before that removal.
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

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
            <GitHubMark className="size-4" />
            {loading ? 'Redirecting…' : 'Sign in with GitHub'}
          </Button>
        </CardContent>
      </Card>
    </CenteredLayout>
  );
}
