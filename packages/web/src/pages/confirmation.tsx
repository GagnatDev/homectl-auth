import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, CircleCheck } from 'lucide-react';
import { CenteredLayout } from '@/components/centered-layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { fetchPublicApp, type PublicAppInfo } from '@/lib/api';

/**
 * Landing shown after invite redemption (?invited=1) or a password reset
 * (?password_reset=1).
 *
 * When the invite granted access to multiple apps, the server redirects here
 * with ?apps=<id,id,…> and we render a chooser so the user can pick which app
 * to continue to. (A single-app invite is redirected straight to the app by
 * the server and never lands here.)
 */
export function ConfirmationPage() {
  const [params] = useSearchParams();
  const invited = params.get('invited') === '1';
  const reset = params.get('password_reset') === '1';
  const appsParam = params.get('apps') ?? '';

  const [apps, setApps] = useState<PublicAppInfo[]>([]);

  useEffect(() => {
    const ids = appsParam.split(',').filter(Boolean);
    if (!invited || ids.length === 0) return;
    let cancelled = false;
    Promise.all(ids.map(fetchPublicApp)).then((results) => {
      if (cancelled) return;
      setApps(results.filter((a): a is PublicAppInfo => a !== null && a.landingUrl !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [invited, appsParam]);

  const hasChooser = invited && apps.length > 0;

  const title = invited
    ? 'Account activated'
    : reset
      ? 'Password updated'
      : 'homectl auth';

  const message = invited
    ? hasChooser
      ? 'Your account is ready. Choose an application to continue to.'
      : 'Your account is ready. You can now sign in from the application you were invited to.'
    : reset
      ? 'Your password has been changed. You can now sign in with your new password.'
      : 'This is the homectl authentication service.';

  return (
    <CenteredLayout>
      <Card>
        <CardHeader className="space-y-3">
          {(invited || reset) && (
            <CircleCheck className="size-10 text-primary" aria-hidden />
          )}
          <CardTitle className="text-xl">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{message}</p>
          {hasChooser && (
            <div className="space-y-2">
              {apps.map((app) => (
                <Button key={app.id} asChild variant="outline" className="w-full justify-between">
                  <a href={app.landingUrl!}>
                    {app.name}
                    <ArrowRight className="size-4" aria-hidden />
                  </a>
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </CenteredLayout>
  );
}
