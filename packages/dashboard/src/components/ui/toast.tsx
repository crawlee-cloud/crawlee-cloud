'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
  Operator-style toast system.

  Usage:
    const toast = useToast();
    toast.success('Webhook deleted');
    toast.error('Failed to abort run', { description: err.message });
    toast.warn('Build still pending');
    toast.info('Polling paused — tab inactive');

  Stacked bottom-right. Auto-dismiss after 4s (configurable per toast).
  Hover pauses dismissal; clicking the X dismisses immediately.
*/

export type ToastTone = 'success' | 'error' | 'warn' | 'info';

export interface ToastOptions {
  description?: string;
  /** ms before auto-dismiss. Pass 0 to disable. Default 4000. */
  duration?: number;
}

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  description?: string;
  duration: number;
  createdAt: number;
}

interface ToastApi {
  success: (msg: string, opts?: ToastOptions) => void;
  error: (msg: string, opts?: ToastOptions) => void;
  warn: (msg: string, opts?: ToastOptions) => void;
  info: (msg: string, opts?: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

let counter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((tone: ToastTone, message: string, opts: ToastOptions = {}) => {
    const id = ++counter;
    const duration = opts.duration ?? 4000;
    setToasts((prev) => [
      ...prev,
      {
        id,
        tone,
        message,
        description: opts.description,
        duration,
        createdAt: Date.now(),
      },
    ]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, o) => push('success', m, o),
      error: (m, o) => push('error', m, o),
      warn: (m, o) => push('warn', m, o),
      info: (m, o) => push('info', m, o),
      dismiss,
    }),
    [push, dismiss]
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </Ctx.Provider>
  );
}

function ToastViewport({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none w-[360px] max-w-[calc(100vw-2rem)]"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(100);
  // refs init to null/duration so we don't read Date.now() during render
  // (React 19's react-hooks/purity rule forbids impure calls in render).
  const remainingRef = useRef(toast.duration);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // Animate the progress bar + auto-dismiss when it reaches 0.
  // setState lives inside a rAF callback, not the effect body — the
  // set-state-in-effect rule applies only to synchronous calls.
  useEffect(() => {
    if (toast.duration === 0) return;
    if (startRef.current === null) startRef.current = Date.now();

    const tick = () => {
      if (paused) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const elapsed = Date.now() - (startRef.current ?? Date.now());
      const remaining = remainingRef.current - elapsed;
      const pct = Math.max(0, (remaining / toast.duration) * 100);
      setProgress(pct);
      if (remaining <= 0) {
        onDismiss();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [paused, toast.duration, onDismiss]);

  // When pause toggles, snap the time accounting so we don't race forward.
  useEffect(() => {
    if (startRef.current === null) return;
    if (paused) {
      remainingRef.current -= Date.now() - startRef.current;
    } else {
      startRef.current = Date.now();
    }
  }, [paused]);

  const Icon =
    toast.tone === 'success'
      ? CheckCircle2
      : toast.tone === 'error'
        ? XCircle
        : toast.tone === 'warn'
          ? AlertTriangle
          : Info;

  const toneClass =
    toast.tone === 'success'
      ? 'text-signal border-l-signal'
      : toast.tone === 'error'
        ? 'text-fail border-l-fail'
        : toast.tone === 'warn'
          ? 'text-warn border-l-warn'
          : 'text-info border-l-info';

  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cn(
        'pointer-events-auto panel bg-card overflow-hidden border-l-2',
        'animate-in slide-in-from-right-2 fade-in duration-200',
        toneClass
      )}
    >
      <div className="px-4 py-3 flex items-start gap-3">
        <Icon className="h-4 w-4 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] text-foreground leading-snug">{toast.message}</p>
          {toast.description && (
            <p className="text-[12px] text-muted-foreground leading-snug mt-1 break-words">
              {toast.description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="text-muted-foreground hover:text-foreground p-0.5 -mr-1 -mt-0.5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {toast.duration > 0 && (
        <div className="h-px bg-current opacity-60" style={{ width: `${progress}%` }} aria-hidden />
      )}
    </div>
  );
}
