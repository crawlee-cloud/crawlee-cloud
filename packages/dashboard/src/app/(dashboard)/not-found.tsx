'use client';

import { ArrowLeft, Home, Search } from 'lucide-react';
import { AppLink } from '@/components/app-link';

/*
  Scoped 404 for routes inside the (dashboard) group. Keeps the chrome
  (sidebar, header) so navigation is one click away. Used both for explicit
  notFound() calls and for unmatched URLs under /actors, /runs, etc.
*/

export default function DashboardNotFound() {
  return (
    <div className="grid place-items-center min-h-[60vh]">
      <div className="max-w-md w-full text-center space-y-5 panel grid-bg p-12">
        <Search className="h-6 w-6 text-muted-foreground/40 mx-auto" />
        <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
          [ RESOURCE · NOT FOUND ]
        </p>
        <h1 className="text-[24px] leading-tight font-medium tracking-tight text-foreground">
          Nothing here.
        </h1>
        <p className="text-[13px] text-muted-foreground">
          The actor, run, dataset, or webhook you&apos;re looking for doesn&apos;t exist (or you
          don&apos;t have access).
        </p>
        <div className="flex items-center justify-center gap-2 pt-2">
          <AppLink
            href="/"
            className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm"
          >
            <Home className="h-3.5 w-3.5" /> console
          </AppLink>
          <button
            type="button"
            onClick={() => history.back()}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-mono uppercase tracking-wider border border-border text-muted-foreground hover:text-foreground hover:border-signal/40 rounded-sm"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> back
          </button>
        </div>
      </div>
    </div>
  );
}
