'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Prev/next pagination control with a "Page X / Y · N items" indicator
 * and a typeable page-number input for jumping directly.
 *
 * Pure presentational — owns no state besides the in-flight value of the
 * page input. The parent holds `offset` (typically driven by the URL via
 * usePageParam) and passes `onChange(newOffset)` to drive page changes.
 *
 * Hides itself entirely when `total <= limit` so single-page lists don't
 * render unnecessary chrome.
 *
 * Out-of-range handling: when `offset >= total` (e.g. the user typed
 * `?page=999` on a 12-page list), the chrome flips to an explicit error
 * mode with a "go to last page" affordance — distinct from the empty-
 * state UI the list-page itself renders.
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
  if (total <= limit) return null;

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.floor(offset / limit) + 1;
  const outOfRange = total > 0 && offset >= total;

  if (outOfRange) {
    return (
      <nav
        className={cn(
          'flex items-center justify-between gap-3 mt-4 pt-3 border-t border-border',
          className
        )}
        aria-label="Pagination"
      >
        <p className="font-mono text-[11px] tnum text-fail">
          Page <span className="text-foreground">{currentPage}</span> doesn&apos;t exist — only{' '}
          <span className="text-foreground">{totalPages.toLocaleString()}</span> page
          {totalPages === 1 ? '' : 's'} available.
        </p>
        <button
          type="button"
          onClick={() => onChange((totalPages - 1) * limit)}
          className="h-8 px-2.5 inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/40 hover:text-signal rounded-sm"
        >
          go to page {totalPages}
        </button>
      </nav>
    );
  }

  return (
    <nav
      className={cn(
        'flex items-center justify-between gap-3 mt-4 pt-3 border-t border-border',
        className
      )}
      aria-label="Pagination"
    >
      <PageIndicator
        currentPage={currentPage}
        totalPages={totalPages}
        total={total}
        onJump={(page) => onChange((page - 1) * limit)}
      />
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(Math.max(0, offset - limit))}
          disabled={currentPage === 1}
          className="h-8 px-2.5 inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/40 hover:text-signal rounded-sm disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          prev
        </button>
        <button
          type="button"
          onClick={() => onChange(offset + limit)}
          disabled={currentPage >= totalPages}
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

/**
 * Inline editable page-number indicator. Local draft state holds whatever
 * the user types so we don't fire onJump on every keystroke; commits on
 * Enter or blur, clamped to [1, totalPages]. Resets when the parent's
 * currentPage changes (e.g. user clicked prev/next).
 */
function PageIndicator({
  currentPage,
  totalPages,
  total,
  onJump,
}: {
  currentPage: number;
  totalPages: number;
  total: number;
  onJump: (page: number) => void;
}) {
  const [draft, setDraft] = useState(String(currentPage));

  useEffect(() => {
    setDraft(String(currentPage));
  }, [currentPage]);

  function commit(): void {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n)) {
      setDraft(String(currentPage));
      return;
    }
    const clamped = Math.min(Math.max(1, n), totalPages);
    if (clamped !== currentPage) onJump(clamped);
    setDraft(String(clamped));
  }

  return (
    <form
      className="font-mono text-[11px] tnum text-muted-foreground inline-flex items-center gap-1"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        commit();
      }}
    >
      <span>Page</span>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        aria-label="Jump to page"
        className="w-12 h-6 px-1.5 text-center bg-input border border-border rounded-sm text-foreground tnum focus:outline-none focus:border-signal/50"
      />
      <span>/</span>
      <span className="text-foreground">{totalPages.toLocaleString()}</span>
      <span className="muted ml-2">·</span>
      <span className="ml-1 text-foreground">{total.toLocaleString()}</span>
      <span> items</span>
    </form>
  );
}
