import * as React from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';

/**
 * Admin chrome: a sticky header with the product mark + primary nav, and a
 * centered content container. Nav collapses gracefully on narrow screens.
 */
export function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-muted/40">
      <header className="sticky top-0 z-10 border-b bg-background">
        <div className="container flex h-14 items-center justify-between gap-4">
          <Link to="/admin" className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-5 text-primary" aria-hidden />
            <span>homectl admin</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm" aria-label="Primary">
            <Link
              to="/admin"
              className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              Users
            </Link>
            <Link
              to="/admin/invite"
              className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              Invite
            </Link>
          </nav>
        </div>
      </header>
      <main className="container py-6 sm:py-8">{children}</main>
    </div>
  );
}
