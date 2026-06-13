import { CenteredLayout } from '@/components/centered-layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function NotFoundPage() {
  return (
    <CenteredLayout>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Page not found</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The page you’re looking for doesn’t exist.
        </CardContent>
      </Card>
    </CenteredLayout>
  );
}
