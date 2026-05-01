'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { BrandStrip, NavContents, OperatorFooter } from '@/components/sidebar';
import { cn } from '@/lib/utils';

/*
  Mobile-only nav: a hamburger button (visible below lg) that opens a
  full-height drawer from the left. Uses the native <dialog> element for
  focus trap + ESC handling, same as the modal/confirm primitives.
*/

export function MobileNavButton() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const handleClose = () => setOpen(false);
    const handleCancel = (e: Event) => {
      e.preventDefault();
      setOpen(false);
    };
    el.addEventListener('close', handleClose);
    el.addEventListener('cancel', handleCancel);
    return () => {
      el.removeEventListener('close', handleClose);
      el.removeEventListener('cancel', handleCancel);
    };
  }, []);

  const handleBackdrop = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) setOpen(false);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="lg:hidden h-7 w-7 grid place-items-center border border-border rounded-sm text-muted-foreground hover:text-foreground hover:border-signal/40"
      >
        <Menu className="h-3.5 w-3.5" />
      </button>

      <dialog
        ref={dialogRef}
        onClick={handleBackdrop}
        aria-label="Navigation"
        className={cn(
          // Reset native dialog styles, position as a left-anchored drawer.
          'p-0 m-0 max-w-full max-h-full bg-transparent text-foreground',
          'backdrop:bg-black/60 backdrop:backdrop-blur-[2px]',
          '[&:not([open])]:hidden',
          'fixed inset-0 w-screen h-screen'
        )}
      >
        {open && (
          <div
            className="w-72 max-w-[85vw] h-screen flex flex-col bg-surface-2 border-r border-border shadow-2xl shadow-black/40 animate-in slide-in-from-left duration-200"
            role="document"
          >
            <div className="relative">
              <BrandStrip />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="absolute right-3 top-1/2 -translate-y-1/2 h-7 w-7 grid place-items-center text-muted-foreground hover:text-foreground border border-border rounded-sm"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <NavContents onNavigate={() => setOpen(false)} />
            <OperatorFooter />
          </div>
        )}
      </dialog>
    </>
  );
}
