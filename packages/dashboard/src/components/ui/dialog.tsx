'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
  Operator-style modal dialog.

  Built on the native <dialog> element so we get:
    - Focus trap (ESC / TAB cycle)
    - ::backdrop pseudo-element for overlay (no portal needed)
    - Programmatic showModal() / close() with proper a11y semantics
  We control the visual layer; the browser handles correctness.
*/

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  /** Mono caption above the title — e.g. "DESTRUCTIVE · CONFIRM" */
  eyebrow?: string;
  children: React.ReactNode;
  /** Footer slot — typically Cancel + Confirm buttons */
  footer?: React.ReactNode;
  /** Set false to prevent backdrop-click-to-close (used for required choices). */
  dismissOnBackdrop?: boolean;
  /** "default" (480px) | "narrow" (380px) | "wide" (640px) */
  size?: 'narrow' | 'default' | 'wide';
  /** Tone hint for accent border (informative only — doesn't change behavior). */
  tone?: 'default' | 'danger' | 'warn';
}

export function Dialog({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  dismissOnBackdrop = true,
  size = 'default',
  tone = 'default',
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Open / close the native dialog in response to the React `open` prop.
  // We DON'T set state in this effect — we call DOM imperative APIs that
  // don't trigger React re-renders, so the lint rule doesn't apply.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // ESC / native cancel → call our onClose (React state update happens in callback, fine).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleClose = () => onClose();
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener('close', handleClose);
    el.addEventListener('cancel', handleCancel);
    return () => {
      el.removeEventListener('close', handleClose);
      el.removeEventListener('cancel', handleCancel);
    };
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDialogElement>) => {
      if (!dismissOnBackdrop) return;
      // Click is on the dialog ELEMENT itself only when on the backdrop —
      // any click inside the panel hits a child instead.
      if (e.target === e.currentTarget) onClose();
    },
    [dismissOnBackdrop, onClose]
  );

  const sizeClass = size === 'narrow' ? 'w-[380px]' : size === 'wide' ? 'w-[640px]' : 'w-[480px]';

  const accentBorder =
    tone === 'danger'
      ? 'border-l-2 border-l-fail'
      : tone === 'warn'
        ? 'border-l-2 border-l-warn'
        : '';

  return (
    <dialog
      ref={ref}
      onClick={handleBackdropClick}
      aria-labelledby={title ? titleId : undefined}
      className={cn(
        // Reset native styles, fill the viewport, and center the inner panel.
        // `hidden` (display:none !important from Tailwind) wins when the
        // dialog is closed, so layout classes are safe to apply unconditionally.
        'p-0 m-0 max-w-full max-h-full bg-transparent text-foreground',
        'backdrop:bg-black/50 backdrop:backdrop-blur-[2px]',
        '[&:not([open])]:hidden',
        'fixed inset-0 w-screen h-screen grid place-items-center'
      )}
    >
      {/* Render inner panel only when open — saves DOM + avoids initial paint flash */}
      {open && (
        <div
          className={cn(
            'panel bg-card relative shadow-2xl shadow-black/40',
            sizeClass,
            accentBorder
          )}
          role="document"
        >
          <header className="px-5 pt-4 pb-3 border-b border-border flex items-start justify-between gap-3">
            <div className="min-w-0">
              {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
              {title && (
                <h2 id={titleId} className="text-base text-foreground leading-tight">
                  {title}
                </h2>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="text-muted-foreground hover:text-foreground p-1 -mr-1 -mt-1 rounded-sm hover:bg-secondary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </header>

          <div className="px-5 py-4 text-[13px] text-foreground">{children}</div>

          {footer && (
            <footer className="px-5 py-3 border-t border-border bg-secondary/40 flex justify-end items-center gap-2">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
