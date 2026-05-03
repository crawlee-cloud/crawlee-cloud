'use client';

import { useEffect, useState } from 'react';

/**
 * Local search-input draft with a 300 ms debounce that syncs to the URL
 * (or any external setter). Returns `[draft, setDraft]` for the input
 * element to bind directly. Whenever the draft stabilizes, the latest
 * value is committed via `commit(value)`.
 *
 * Re-syncs the draft if the external value changes (e.g. user clicked
 * a "clear" button or loaded a `?q=foo` URL fresh) so the input never
 * lies about what the URL says.
 */
export function useDebouncedSearch(
  externalValue: string,
  commit: (value: string) => void,
  delayMs = 300
): [string, (next: string) => void] {
  const [draft, setDraft] = useState(externalValue);

  // External → draft (URL navigated, parent reset, etc).
  useEffect(() => {
    setDraft(externalValue);
  }, [externalValue]);

  // Draft → external (debounced). Skip the initial render where draft
  // equals externalValue to avoid a redundant URL push on mount.
  useEffect(() => {
    if (draft === externalValue) return;
    const id = setTimeout(() => commit(draft), delayMs);
    return () => clearTimeout(id);
  }, [draft, externalValue, commit, delayMs]);

  return [draft, setDraft];
}
