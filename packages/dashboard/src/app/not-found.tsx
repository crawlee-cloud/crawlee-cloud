import { Home } from 'lucide-react';
import { AppLink } from '@/components/app-link';

/*
  Root 404 — used for routes outside the (dashboard) group. Inside the
  dashboard we override with a scoped not-found.tsx that keeps the chrome.
*/

export default function NotFound() {
  return (
    <div className="min-h-screen grid place-items-center px-6">
      <div className="max-w-md w-full text-center space-y-5">
        <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
          [ HTTP · 404 · NOT FOUND ]
        </p>
        <h1 className="text-[40px] leading-none font-mono tracking-tight text-foreground tnum">
          404
        </h1>
        <p className="text-[14px] text-muted-foreground">
          The address you requested doesn&apos;t map to a page on this console.
        </p>
        <AppLink
          href="/"
          className="inline-flex items-center gap-1.5 h-9 px-4 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm"
        >
          <Home className="h-3.5 w-3.5" /> back to console
        </AppLink>
      </div>
    </div>
  );
}
