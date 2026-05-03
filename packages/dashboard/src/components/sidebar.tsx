'use client';

import Image from 'next/image';
import { AppLink } from '@/components/app-link';
import { prefixPath, ROUTE_PREFIX } from '@/lib/path-prefix';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Play,
  Drama,
  Database,
  Settings,
  BookOpen,
  LogOut,
  Webhook,
  Hammer,
  CalendarClock,
  Boxes,
  ListOrdered,
  Cpu,
  Trash2,
} from 'lucide-react';
import { APP_VERSION } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

type Item = { href: string; label: string; icon: LucideIcon; soon?: boolean };
type Group = { id: string; label: string; items: Item[] };

/*
  Single source of truth for the dashboard navigation. Used by both the
  desktop sidebar and the mobile drawer (in mobile-nav.tsx).
*/
export const navGroups: Group[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [{ href: '/', label: 'Console', icon: LayoutDashboard }],
  },
  {
    id: 'run',
    label: 'Run',
    items: [
      { href: '/runs', label: 'Runs', icon: Play },
      { href: '/schedules', label: 'Schedules', icon: CalendarClock },
    ],
  },
  {
    id: 'build',
    label: 'Build',
    items: [
      { href: '/actors', label: 'Actors', icon: Drama },
      { href: '/builds', label: 'Builds', icon: Hammer },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    items: [
      { href: '/datasets', label: 'Datasets', icon: Database },
      { href: '/key-value-stores', label: 'KV Stores', icon: Boxes },
      { href: '/request-queues', label: 'Queues', icon: ListOrdered },
    ],
  },
  {
    id: 'integrate',
    label: 'Integrate',
    // API Keys management lives inside the Settings page; not duplicated here.
    items: [{ href: '/webhooks', label: 'Webhooks', icon: Webhook }],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { href: '/runners', label: 'Runners', icon: Cpu },
      { href: '/retention', label: 'Retention', icon: Trash2 },
      { href: '/settings', label: 'Settings', icon: Settings },
      { href: '/docs', label: 'Docs', icon: BookOpen },
    ],
  },
];

/*
  Brand strip — repeated by both the desktop sidebar and the mobile drawer header.
  Uses the real Crawlee Cloud cloud icon (orange→red gradient SVG) with the
  OPERATOR caption alongside.
*/
export function BrandStrip() {
  return (
    <div className="h-14 px-4 flex items-center gap-2.5 border-b border-border shrink-0">
      {/* Inline-style background so the SVG fills our intended footprint cleanly */}
      <AppLink
        href="/"
        className="shrink-0 h-7 w-7 grid place-items-center rounded-sm hover:bg-secondary/40 transition-colors"
        aria-label="Crawlee Cloud — back to console"
      >
        <Image
          src={prefixPath('/logo-icon.svg')}
          alt="Crawlee Cloud"
          width={28}
          height={28}
          priority
          className="block"
        />
      </AppLink>
      <div className="flex flex-col leading-none min-w-0">
        <span className="font-mono text-[11px] tracking-widest text-foreground truncate">
          CRAWLEE CLOUD
        </span>
        <span className="font-mono text-[9px] tracking-[0.22em] text-muted-foreground">
          OPERATOR · v{APP_VERSION}
        </span>
      </div>
    </div>
  );
}

/*
  The actual nav list — shared between sidebar and mobile drawer.
  `onNavigate` lets the mobile drawer close itself when a link is clicked.
*/
export function NavContents({ onNavigate }: { onNavigate?: () => void }) {
  const rawPathname = usePathname();
  const pathname =
    ROUTE_PREFIX && rawPathname.startsWith(ROUTE_PREFIX)
      ? rawPathname.slice(ROUTE_PREFIX.length) || '/'
      : rawPathname;

  return (
    <nav className="flex-1 overflow-y-auto py-4">
      {navGroups.map((group) => (
        <div key={group.id} className="mb-5 px-3">
          <div className="px-2 mb-1.5 flex items-center gap-2">
            <span className="eyebrow">{group.label}</span>
            <span className="flex-1 h-px bg-border" />
          </div>
          <ul className="space-y-px">
            {group.items.map((item) => {
              const isActive =
                !item.soon &&
                (pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href)));
              const Icon = item.icon;
              const baseRow =
                'group flex items-center gap-2.5 px-2 py-1.5 text-[13px] rounded-sm transition-colors relative';

              if (item.soon) {
                return (
                  <li key={item.href}>
                    <span
                      aria-disabled="true"
                      className={cn(
                        baseRow,
                        'text-muted-foreground/70 cursor-not-allowed select-none'
                      )}
                      title="Coming soon"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                      <span className="flex-1">{item.label}</span>
                      <span className="font-mono text-[9px] tracking-wider text-muted-foreground/70 border border-border px-1 rounded-sm">
                        SOON
                      </span>
                    </span>
                  </li>
                );
              }

              return (
                <li key={item.href}>
                  <AppLink
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      baseRow,
                      isActive
                        ? 'text-foreground bg-signal/5'
                        : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                    )}
                  >
                    {isActive && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-3.5 bg-signal" />
                    )}
                    <Icon
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        isActive
                          ? 'text-signal'
                          : 'text-muted-foreground group-hover:text-foreground'
                      )}
                    />
                    <span className="flex-1">{item.label}</span>
                  </AppLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/*
  Operator footer — identity card with sign-out.
*/
export function OperatorFooter() {
  return (
    <div className="border-t border-border px-3 py-3 shrink-0">
      <div className="flex items-center gap-2.5 px-2 py-2 bg-secondary/40 border border-border rounded-sm">
        <div className="h-7 w-7 rounded-sm bg-signal/10 border border-signal/40 grid place-items-center">
          <span className="font-mono text-[10px] text-signal">OP</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[12px] text-foreground truncate leading-tight">Operator</p>
          <p className="text-[10px] text-muted-foreground font-mono leading-tight flex items-center gap-1.5 mt-0.5">
            <span className="live-dot" /> self-hosted
          </p>
        </div>
        <button
          type="button"
          aria-label="Sign out"
          onClick={() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            document.cookie = 'token=; path=/; max-age=0';
            window.location.href = prefixPath('/login');
          }}
          className="text-muted-foreground hover:text-fail transition-colors p-1"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col h-screen sticky top-0 border-r border-border bg-surface-2">
      <BrandStrip />
      <NavContents />
      <OperatorFooter />
    </aside>
  );
}
