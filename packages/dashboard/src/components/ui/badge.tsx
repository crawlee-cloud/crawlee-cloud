import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/*
  Operator Console badge.
  - All variants are flat: foreground color + 1px border in same hue, no fill swap on hover.
  - "chip" variant draws as [STATUS] in mono — used for RUN status, BUILD status, etc.
*/

const badgeVariants = cva(
  'inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium tabular-nums rounded-sm border',
  {
    variants: {
      variant: {
        default: 'border-border bg-secondary text-foreground',
        outline: 'border-border bg-transparent text-muted-foreground',
        secondary: 'border-border bg-secondary text-foreground',

        // `success` deliberately uses `ok` (semantic green), NOT `signal`
        // (brand orange). They USED to collide and made SUCCEEDED chips
        // visually indistinguishable from ABORTED (warn) and FAILED at
        // a glance — see globals.css comment on --ok.
        success: 'border-ok/40 bg-ok/10 text-ok',
        warning: 'border-warn/40 bg-warn/10 text-warn',
        error: 'border-fail/40 bg-fail/10 text-fail',
        destructive: 'border-fail/40 bg-fail/10 text-fail',
        info: 'border-info/40 bg-info/10 text-info',

        // Legacy variant kept for compatibility with existing call sites;
        // re-skinned to match the operator console aesthetic.
        glass: 'border-border bg-secondary text-muted-foreground',
      },
      shape: {
        chip: 'font-mono uppercase tracking-wider',
        pill: 'rounded-full',
        square: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      shape: 'square',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, shape, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant, shape }), className)} {...props} />;
}

/*
  Helper: render a run/build status as a bracketed mono chip.
  Maps status string → variant + label, so call sites stop branching.
*/
// Wide string keeps it open to future statuses without a type bump.
// The literals exist as documentation for which values get a coloured
// variant in STATUS_VARIANT below; anything else falls through to outline.
type StatusKind = string;

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'info' | 'outline'> = {
  SUCCEEDED: 'success',
  RUNNING: 'info',
  BUILDING: 'info',
  PENDING: 'outline',
  READY: 'outline',
  FAILED: 'error',
  'TIMED-OUT': 'error',
  ABORTING: 'warning',
  ABORTED: 'warning',
};

export function StatusChip({ status, className }: { status: StatusKind; className?: string }) {
  const variant = STATUS_VARIANT[status] ?? 'outline';
  const showLive = status === 'RUNNING' || status === 'BUILDING';
  return (
    <Badge variant={variant} shape="chip" className={cn('px-2', className)}>
      {showLive && <span className="live-dot mr-0.5" aria-hidden />}
      <span>[{status}]</span>
    </Badge>
  );
}

export { Badge, badgeVariants };
