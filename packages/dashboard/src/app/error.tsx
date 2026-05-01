'use client';

import { useEffect } from 'react';
import { RotateCw, Home } from 'lucide-react';
import { AppLink } from '@/components/app-link';

/*
  Root error boundary. Renders for any uncaught throw in a server or client
  component below. Per Next.js convention, must be a Client Component and
  receives `error` (with optional `digest`) plus a `reset` retrier.
*/

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Surface the full error to the dev console — production may have already
  // shipped a stack-stripped Error here.
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <div className="max-w-md w-full space-y-6">
        <header>
          <p className="font-mono text-[11px] tracking-widest text-fail mb-3">
            [ FATAL · UNCAUGHT ]
          </p>
          <h1 className="text-[28px] leading-tight font-medium tracking-tight text-foreground">
            Something blew up.
          </h1>
          <p className="text-[13px] text-muted-foreground mt-2">
            The console hit an unrecoverable error rendering this page.
            {error.digest && (
              <>
                {' '}
                Digest <code className="font-mono text-foreground">{error.digest}</code>.
              </>
            )}
          </p>
        </header>

        <pre className="panel bg-card p-4 font-mono text-[11px] text-foreground whitespace-pre-wrap break-all max-h-64 overflow-auto">
          {error.message || String(error)}
        </pre>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="h-9 px-4 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm"
          >
            <RotateCw className="h-3.5 w-3.5" /> retry
          </button>
          <AppLink
            href="/"
            className="h-9 px-4 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border text-foreground hover:border-signal/40 hover:text-signal rounded-sm"
          >
            <Home className="h-3.5 w-3.5" /> console
          </AppLink>
        </div>
      </div>
    </div>
  );
}
