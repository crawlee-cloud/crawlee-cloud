'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PAGE_SIZE } from '@/lib/constants';

/**
 * URL-driven pagination state. Reads `?page=N` (1-indexed) from the
 * current URL and writes it back via router.push so back/forward, copy-
 * paste links, and manual `?page=42` edits all "just work."
 *
 * Returns:
 *   - `page`     — 1-indexed page number (≥ 1, clamped from URL).
 *   - `offset`   — derived `(page - 1) * PAGE_SIZE`, ready for the API.
 *   - `setPage`  — writes a 1-indexed page number to the URL.
 *   - `setOffset`— writes an offset (matches the Pagination component's
 *                  `onChange(newOffset)` contract — preferred for that
 *                  callsite to avoid manual page math).
 *
 * Page=1 omits the param so the canonical first-page URL stays clean
 * (`/datasets`, not `/datasets?page=1`). Other querystring params are
 * preserved.
 */
export function usePageParam(): {
  page: number;
  offset: number;
  setPage: (page: number) => void;
  setOffset: (offset: number) => void;
} {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const raw = parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(raw) && raw >= 1 ? raw : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const setPage = useCallback(
    (next: number) => {
      const clamped = Math.max(1, Math.floor(next));
      const params = new URLSearchParams(searchParams.toString());
      if (clamped === 1) params.delete('page');
      else params.set('page', String(clamped));
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [searchParams, router, pathname]
  );

  const setOffset = useCallback(
    (newOffset: number) => setPage(Math.floor(newOffset / PAGE_SIZE) + 1),
    [setPage]
  );

  return { page, offset, setPage, setOffset };
}
