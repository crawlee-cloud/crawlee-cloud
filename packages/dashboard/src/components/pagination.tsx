'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Prev/next pagination control with a "Showing X–Y of N" indicator.
 *
 * Pure presentational — owns no state. The parent holds `offset` and
 * passes `onChange(newOffset)` to drive page transitions. `limit` is
 * static per page (no page-size selector here; add one separately if
 * a page needs it).
 *
 * Hides itself entirely when `total <= limit` so list pages with a
 * single page of data don't render unnecessary chrome.
 */
export function Pagination({
  total,
  offset,
  limit,
  onChange,
  className,
}: {
  total: number;
  offset: number;
  limit: number;
  onChange: (newOffset: number) => void;
  className?: string;
}) {
  // Single-page lists: render nothing. Total === 0 also collapses here.
  if (total <= limit) return null;

  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);

  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  return (
    <nav
      className={cn(
        'flex items-center justify-between gap-3 mt-4 pt-3 border-t border-border',
        className
      )}
      aria-label="Pagination"
    >
      <p className="font-mono text-[11px] tnum text-muted-foreground">
        Showing <span className="text-foreground">{start.toLocaleString()}</span>
        <span className="muted">–</span>
        <span className="text-foreground">{end.toLocaleString()}</span>
        <span className="muted"> of </span>
        <span className="text-foreground">{total.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(Math.max(0, offset - limit))}
          disabled={!canPrev}
          className="h-8 px-2.5 inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/40 hover:text-signal rounded-sm disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          prev
        </button>
        <button
          type="button"
          onClick={() => onChange(offset + limit)}
          disabled={!canNext}
          className="h-8 px-2.5 inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/40 hover:text-signal rounded-sm disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
          aria-label="Next page"
        >
          next
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </nav>
  );
}
