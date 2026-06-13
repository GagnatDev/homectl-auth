import { useSearchParams } from 'react-router-dom';
import { CircleCheck } from 'lucide-react';
import { CenteredLayout } from '@/components/centered-layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Landing shown after invite redemption (?invited=1) or a password reset
 * (?password_reset=1). There is no app context here, so we confirm and point
 * the user back to the application they started from.
 */
export function ConfirmationPage() {
  const [params] = useSearchParams();
  const invited = params.get('invited') === '1';
  const reset = params.get('password_reset') === '1';

  const title = invited
    ? 'Account activated'
    : reset
      ? 'Password updated'
      : 'homectl auth';

  const message = invited
    ? 'Your account is ready. You can now sign in from the application you were invited to.'
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
        <CardContent className="text-sm text-muted-foreground">{message}</CardContent>
      </Card>
    </CenteredLayout>
  );
}
