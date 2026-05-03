'use client';

import { useEffect, useState } from 'react';
import { Trash2, RotateCw, ShieldAlert } from 'lucide-react';
import { getRetentionStatus, type RetentionStatus } from '@/lib/api';
import { POLL_RETENTION_MS } from '@/lib/constants';
import { cn } from '@/lib/utils';

export default function RetentionPage() {
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setRefreshing(true);
    try {
      const s = await getRetentionStatus();
      setStatus(s);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
    // Reaper ticks daily by default — no need to auto-refresh aggressively.
    // The constant lets ops bump cadence without code-archeology.
    const id = setInterval(() => void load(), POLL_RETENTION_MS);
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return (
      <div className="grid place-items-center min-h-[40vh]">
        <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
          [ LOADING · · · ]
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <header className="pb-4 border-b border-border">
          <p className="eyebrow mb-2">SYSTEM · RETENTION</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Retention</h1>
        </header>
        <div className="panel border-l-2 border-l-fail p-5">
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-4 w-4 text-fail mt-0.5 shrink-0" />
            <div>
              <p className="font-mono text-[10px] tracking-widest text-fail uppercase mb-1">
                [ ACCESS · DENIED ]
              </p>
              <p className="text-[13px] text-foreground">{error}</p>
              <p className="text-[12px] text-muted-foreground mt-2">
                The retention status endpoint requires admin role. Sign in as an admin user to view
                reaper state.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!status) return null;

  const total24h =
    status.reapedLast24h.dataset +
    status.reapedLast24h.key_value_store +
    status.reapedLast24h.request_queue +
    status.reapedLast24h.run;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6 pb-4 border-b border-border">
        <div>
          <p className="eyebrow mb-2">SYSTEM · RETENTION</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Retention</h1>
          <p className="text-muted-foreground mt-2 text-[13px]">
            Periodic reaper for unnamed datasets, KV stores, request queues, and finished runs past
            their TTL. Refreshes every 30s.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/40 hover:text-signal rounded-sm disabled:opacity-50"
        >
          <RotateCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /> refresh
        </button>
      </div>

      {/* Reaper config + last-tick state */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border rounded-md overflow-hidden">
        <Tile label="Reaper" tone={status.enabled ? 'signal' : undefined} live={status.enabled}>
          {status.enabled ? 'ON' : 'OFF'}
        </Tile>
        <Tile label="Last tick">
          {status.lastTickAt ? timeAgo(status.lastTickAt) : <span className="muted">—</span>}
        </Tile>
        <Tile label="Last duration">
          {status.lastTickElapsedMs !== null ? (
            `${status.lastTickElapsedMs}ms`
          ) : (
            <span className="muted">—</span>
          )}
        </Tile>
        <Tile label="Tombstones">{status.tombstoneRowCount.toLocaleString()}</Tile>
      </div>

      {/* Reaped in last 24h, broken down by kind */}
      <section className="panel">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2">
          <Trash2 className="h-3.5 w-3.5 text-signal" />
          <span className="eyebrow">REAPED · LAST 24H</span>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground tnum">
            {total24h.toLocaleString()} total
          </span>
        </header>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border">
          <Tile label="Datasets" tone={status.reapedLast24h.dataset > 0 ? 'signal' : undefined}>
            {status.reapedLast24h.dataset.toLocaleString()}
          </Tile>
          <Tile
            label="KV Stores"
            tone={status.reapedLast24h.key_value_store > 0 ? 'signal' : undefined}
          >
            {status.reapedLast24h.key_value_store.toLocaleString()}
          </Tile>
          <Tile label="Queues" tone={status.reapedLast24h.request_queue > 0 ? 'signal' : undefined}>
            {status.reapedLast24h.request_queue.toLocaleString()}
          </Tile>
          <Tile label="Runs" tone={status.reapedLast24h.run > 0 ? 'signal' : undefined}>
            {status.reapedLast24h.run.toLocaleString()}
          </Tile>
        </div>
      </section>

      {!status.enabled && (
        <div className="panel border-l-2 border-l-warn p-5">
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-4 w-4 text-warn mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-mono text-[10px] tracking-widest text-warn uppercase">
                [ RETENTION · DISABLED ]
              </p>
              <p className="text-[13px] text-foreground">
                The reaper is currently disabled. Tables will grow indefinitely.
              </p>
              <p className="text-[12px] text-muted-foreground">
                Set <span className="font-mono">RETENTION_ENABLED=true</span> and restart the API to
                enable. See <span className="font-mono">docs/deployment/</span> for details.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({
  label,
  children,
  tone,
  live,
}: {
  label: string;
  children: React.ReactNode;
  tone?: 'signal' | 'info' | 'warn' | 'fail';
  live?: boolean;
}) {
  const toneClass =
    tone === 'signal'
      ? 'text-signal'
      : tone === 'info'
        ? 'text-info'
        : tone === 'warn'
          ? 'text-warn'
          : tone === 'fail'
            ? 'text-fail'
            : 'text-foreground';
  return (
    <div className="bg-card px-5 py-4">
      <div className="flex items-center justify-between mb-2">
        <span className="eyebrow">{label}</span>
        {live && <span className="live-dot" />}
      </div>
      <div className={cn('text-2xl font-mono tnum tracking-tight leading-none', toneClass)}>
        {children}
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
