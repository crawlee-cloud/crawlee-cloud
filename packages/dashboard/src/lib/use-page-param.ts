'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PAGE_SIZE } from '@/lib/constants';

/**
 * URL-driven pagination + search state. Reads `?page=N` (1-indexed) and
 * `?q=<text>` from the current URL and writes them back via router.push
 * so back/forward, copy-paste links, and manual `?page=42&q=foo` edits
 * all "just work."
 *
 * Returns:
 *   - `page`     — 1-indexed page number (≥ 1, clamped from URL).
 *   - `offset`   — derived `(page - 1) * PAGE_SIZE`, ready for the API.
 *   - `query`    — current `?q=` text (empty string if absent).
 *   - `setPage`  — writes a 1-indexed page number to the URL.
 *   - `setOffset`— writes an offset (matches the Pagination component's
 *                  `onChange(newOffset)` contract).
 *   - `setQuery` — writes a search string. Resets `?page=` so the user
 *                  doesn't end up on page 14 of a freshly-narrowed list.
 *
 * Page=1 omits the param so `/datasets` stays clean. Empty query string
 * removes the `?q=` param entirely. Other querystring params are
 * preserved.
 */
export function usePageParam(): {
  page: number;
  offset: number;
  query: string;
  setPage: (page: number) => void;
  setOffset: (offset: number) => void;
  setQuery: (q: string) => void;
} {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const raw = parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(raw) && raw >= 1 ? raw : 1;
  const offset = (page - 1) * PAGE_SIZE;
  const query = searchParams.get('q') ?? '';

  const writeParams = useCallback(
    (mutator: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutator(params);
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [searchParams, router, pathname]
  );

  const setPage = useCallback(
    (next: number) => {
      const clamped = Math.max(1, Math.floor(next));
      writeParams((params) => {
        if (clamped === 1) params.delete('page');
        else params.set('page', String(clamped));
      });
    },
    [writeParams]
  );

  const setOffset = useCallback(
    (newOffset: number) => setPage(Math.floor(newOffset / PAGE_SIZE) + 1),
    [setPage]
  );

  const setQuery = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      writeParams((params) => {
        // Resetting `page` is important — staying on page 14 with a new
        // search term that returns 3 results would land on the empty
        // overflow state immediately.
        params.delete('page');
        if (trimmed === '') params.delete('q');
        else params.set('q', trimmed);
      });
    },
    [writeParams]
  );

  return { page, offset, query, setPage, setOffset, setQuery };
}
