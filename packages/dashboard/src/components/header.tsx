'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';
import { ROUTE_PREFIX } from '@/lib/path-prefix';
import { MobileNavButton } from '@/components/mobile-nav';

/*
  Theme toggle reads localStorage to render the correct icon, which the server
  can't know about. Loading client-only avoids hydration mismatch on every page.
  Placeholder reserves the same 28px slot to prevent layout shift.
*/
const ThemeToggle = dynamic(() => import('@/components/theme-toggle').then((m) => m.ThemeToggle), {
  ssr: false,
  loading: () => <div className="h-7 w-[58px] border border-border rounded-sm" />,
});

/*
  Operator-style header. A flat 40px strip:
    [breadcrumb path] · [search]                      [system clock]
  No avatar, no notification bell, no glass blur. Reads like a console title bar.
*/

function useClock() {
  const [time, setTime] = useState<string>('');
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      const ss = String(d.getUTCSeconds()).padStart(2, '0');
      setTime(`${hh}:${mm}:${ss}Z`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

function useBreadcrumb() {
  const raw = usePathname();
  const path =
    ROUTE_PREFIX && raw.startsWith(ROUTE_PREFIX) ? raw.slice(ROUTE_PREFIX.length) || '/' : raw;
  if (path === '/') return ['console'];
  return path.split('/').filter(Boolean);
}

export function Header() {
  const time = useClock();
  const crumbs = useBreadcrumb();

  return (
    <header className="h-10 shrink-0 px-3 sm:px-4 flex items-center justify-between gap-2 sm:gap-4 border-b border-border bg-surface-2 sticky top-0 z-10">
      {/* Mobile nav trigger — hidden on lg+ where the sidebar is visible */}
      <MobileNavButton />

      {/* Breadcrumb path */}
      <div className="flex items-center gap-2 font-mono text-[11px] tracking-wide min-w-0 flex-1 lg:flex-initial">
        <span className="text-muted-foreground">~/</span>
        {crumbs.map((c, i) => (
          <span key={`${c}-${i}`} className="flex items-center gap-2 truncate">
            <span className={i === crumbs.length - 1 ? 'text-foreground' : 'text-muted-foreground'}>
              {c.length > 24 ? c.slice(0, 8) + '…' + c.slice(-4) : c}
            </span>
            {i < crumbs.length - 1 && <span className="text-muted-foreground/50">/</span>}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-3">
        {/* Search — placeholder, kept lean */}
        <div className="relative hidden md:block">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            type="search"
            placeholder="search"
            className="h-7 w-56 pl-7 pr-12 rounded-sm border border-border bg-secondary/40 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-signal/40"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[9px] text-muted-foreground tracking-widest">
            ⌘K
          </span>
        </div>

        {/* Theme cycle */}
        <ThemeToggle />

        {/* System clock + status */}
        <div className="flex items-center gap-2 font-mono text-[10px] tracking-wider text-muted-foreground">
          <span className="live-dot" aria-hidden />
          <span className="hidden sm:inline">SYS·OK</span>
          <span className="text-foreground tnum">{time}</span>
        </div>
      </div>
    </header>
  );
}
