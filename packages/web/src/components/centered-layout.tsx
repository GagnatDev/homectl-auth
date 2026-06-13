import * as React from 'react';

/**
 * Full-viewport centered column for the public auth pages (login, invite,
 * reset, confirmation). Mobile-first: comfortable padding on small screens, a
 * capped card width on larger ones.
 */
export function CenteredLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
