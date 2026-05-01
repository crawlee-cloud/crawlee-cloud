'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/*
  Promise-based confirm dialog.

  Usage:
    const confirm = useConfirm();
    if (await confirm({ title: 'Delete actor?', tone: 'danger' })) {
      await deleteActor(id);
    }

  The provider is mounted once at the dashboard layout level.
*/

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  /** Caption above the title — e.g. "DESTRUCTIVE · IRREVERSIBLE" */
  eyebrow?: string;
  /** Confirm button label. Default "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Default "Cancel". */
  cancelLabel?: string;
  /** Tone affects accent border + confirm button color. */
  tone?: 'default' | 'danger' | 'warn';
  /** Optional async work to run on confirm; spinner shows until it resolves. */
  onConfirm?: () => unknown;
}

type Resolver = (value: boolean) => void;

interface ConfirmCtx {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<ConfirmCtx | null>(null);

export function useConfirm() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx.confirm;
}

interface ActiveState {
  opts: ConfirmOptions;
  resolve: Resolver;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<ActiveState | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setActive({ opts, resolve });
    });
  }, []);

  const close = useCallback(
    (result: boolean) => {
      if (!active || busy) return;
      active.resolve(result);
      setActive(null);
    },
    [active, busy]
  );

  const handleConfirm = useCallback(async () => {
    if (!active) return;
    if (active.opts.onConfirm) {
      setBusy(true);
      try {
        await active.opts.onConfirm();
        active.resolve(true);
        setActive(null);
      } catch {
        // Caller's onConfirm threw; surface failure as a "false" result so
        // they can decide whether to toast or retry. They can also catch
        // inside their own onConfirm if they prefer.
        active.resolve(false);
        setActive(null);
      } finally {
        setBusy(false);
      }
    } else {
      active.resolve(true);
      setActive(null);
    }
  }, [active]);

  const value = useMemo(() => ({ confirm }), [confirm]);

  const opts = active?.opts;
  const isDanger = opts?.tone === 'danger';
  const isWarn = opts?.tone === 'warn';
  const confirmTone = isDanger
    ? 'border-fail/40 bg-fail/10 text-fail hover:bg-fail/20'
    : isWarn
      ? 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20'
      : 'bg-signal text-background hover:brightness-110 border border-transparent';

  return (
    <Ctx.Provider value={value}>
      {children}
      <Dialog
        open={!!active}
        onClose={() => close(false)}
        eyebrow={opts?.eyebrow ?? (isDanger ? 'DESTRUCTIVE · CONFIRM' : 'CONFIRM')}
        title={opts?.title}
        tone={opts?.tone}
        size="narrow"
        dismissOnBackdrop={!busy}
        footer={
          <>
            <button
              type="button"
              onClick={() => close(false)}
              disabled={busy}
              className="h-8 px-3 text-[12px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {opts?.cancelLabel ?? 'cancel'}
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={busy}
              className={cn(
                'h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider rounded-sm disabled:opacity-50',
                confirmTone
              )}
              autoFocus
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {opts?.confirmLabel ?? 'confirm'}
            </button>
          </>
        }
      >
        {opts?.description ? (
          <div className="text-muted-foreground leading-relaxed">{opts.description}</div>
        ) : null}
      </Dialog>
    </Ctx.Provider>
  );
}
