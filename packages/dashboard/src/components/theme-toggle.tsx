'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

import { cn } from '@/lib/utils';

/*
  Three-state cycle: system → light → dark → system.
  Operator-style — flat icon button with mono caption, no fade transition.

  Loaded with `ssr: false` from header.tsx, so we never render on the server
  and there's no hydration mismatch when next-themes resolves localStorage.
*/

const ORDER = ['system', 'light', 'dark'] as const;
type Mode = (typeof ORDER)[number];

const ICON: Record<Mode, React.ComponentType<{ className?: string }>> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

const LABEL: Record<Mode, string> = {
  system: 'SYS',
  light: 'LGT',
  dark: 'DRK',
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const current: Mode = (theme as Mode) || 'system';
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  const Icon = ICON[current];

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Theme · ${current} → ${next}`}
      aria-label={`Theme: ${current}. Click to switch to ${next}.`}
      className={cn(
        'h-7 px-2 inline-flex items-center gap-1.5 border border-border rounded-sm',
        'font-mono text-[10px] tracking-widest text-muted-foreground',
        'hover:text-foreground hover:border-signal/40 transition-colors'
      )}
    >
      <Icon className="h-3 w-3" />
      <span>{LABEL[current]}</span>
    </button>
  );
}
