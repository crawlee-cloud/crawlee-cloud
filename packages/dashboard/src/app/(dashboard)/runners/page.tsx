'use client';

import { useEffect, useState } from 'react';
import { Cpu, RotateCw, ShieldAlert } from 'lucide-react';
import { getScalerStatus, type RunnerInfo, type ScalerStatus } from '@/lib/api';
import { POLL_RUNNERS_MS } from '@/lib/constants';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<RunnerInfo['status'], 'signal' | 'info' | 'warn' | 'fail' | 'muted'> = {
  ready: 'signal',
  busy: 'info',
  creating: 'warn',
  draining: 'warn',
  destroying: 'fail',
  dead: 'fail',
};

export default function RunnersPage() {
  const [status, setStatus] = useState<ScalerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setRefreshing(true);
    try {
      const s = await getScalerStatus();
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
    // Auto-refresh while open — runner state changes fast.
    const id = setInterval(() => void load(), POLL_RUNNERS_MS);
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
          <p className="eyebrow mb-2">SYSTEM · RUNNERS</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Runners</h1>
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
                The scaler status endpoint requires admin role. Sign in as an admin user to view
                runner state.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!status) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6 pb-4 border-b border-border">
        <div>
          <p className="eyebrow mb-2">SYSTEM · RUNNERS</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Runners</h1>
          <p className="text-muted-foreground mt-2 text-[13px]">
            Auto-scaler state. Live every 5s.
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

      {/* Scaler config + state */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border rounded-md overflow-hidden">
        <Tile label="Scaler" tone={status.enabled ? 'signal' : undefined} live={status.enabled}>
          {status.enabled ? 'ON' : 'OFF'}
        </Tile>
        <Tile label="Provider">
          <span className="text-[15px] font-mono">{status.provider}</span>
        </Tile>
        <Tile label="Min · Max">
          {status.config.min} · {status.config.max}
        </Tile>
        <Tile label="Runs / runner">{status.config.runsPerRunner}</Tile>
      </div>

      {/* Queue snapshot */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border border border-border rounded-md overflow-hidden">
        <Tile label="Queue · ready" tone={status.queue.ready > 0 ? 'signal' : undefined}>
          {status.queue.ready}
        </Tile>
        <Tile label="Queue · running" tone={status.queue.running > 0 ? 'info' : undefined}>
          {status.queue.running}
        </Tile>
        <Tile label="Queue · total">{status.queue.total}</Tile>
      </div>

      {/* Runners */}
      <section className="panel">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2">
          <Cpu className="h-3.5 w-3.5 text-signal" />
          <span className="text-[13px] text-foreground">Runners</span>
          <span className="font-mono text-[10px] text-muted-foreground tracking-wider">
            · {status.runners.length} tracked
          </span>
        </header>
        {status.runners.length === 0 ? (
          <div className="grid-bg p-16 text-center">
            <Cpu className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              [ NO RUNNERS ]
            </p>
            <p className="text-[13px] text-muted-foreground mt-2">
              {status.enabled
                ? 'Scaler is on but no runners are spawned. Will scale up on next ready run.'
                : 'Scaler is off. Runs are processed by any locally-running runner process.'}
            </p>
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-widest text-muted-foreground uppercase border-b border-border">
                <th className="px-5 py-2 font-normal">Runner</th>
                <th className="px-5 py-2 font-normal">Status</th>
                <th className="px-5 py-2 font-normal">IP</th>
                <th className="px-5 py-2 font-normal text-right">Active runs</th>
                <th className="px-5 py-2 font-normal text-right">Created</th>
              </tr>
            </thead>
            <tbody>
              {status.runners.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border/60 last:border-0 hover:bg-secondary/40"
                >
                  <td className="px-5 py-3 font-mono text-foreground">{r.id.slice(0, 16)}</td>
                  <td className="px-5 py-3">
                    <RunnerChip status={r.status} />
                  </td>
                  <td className="px-5 py-3 font-mono text-[12px] text-muted-foreground">
                    {r.ip || '—'}
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-foreground tnum">
                    {r.activeRuns}
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-[11px] text-muted-foreground tnum">
                    {timeAgo(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Heartbeats */}
      {status.heartbeats.length > 0 && (
        <section className="panel">
          <header className="px-5 py-3 border-b border-border flex items-center gap-2">
            <span className="live-dot" />
            <span className="text-[13px] text-foreground">Live heartbeats</span>
            <span className="font-mono text-[10px] text-muted-foreground tracking-wider">
              · {status.heartbeats.length}
            </span>
          </header>
          <pre className="p-5 font-mono text-[11px] text-foreground overflow-auto max-h-96 bg-background/40">
            {JSON.stringify(status.heartbeats, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}

function RunnerChip({ status }: { status: RunnerInfo['status'] }) {
  const tone = STATUS_TONE[status];
  const cls =
    tone === 'signal'
      ? 'border-signal/40 bg-signal/10 text-signal'
      : tone === 'info'
        ? 'border-info/40 bg-info/10 text-info'
        : tone === 'warn'
          ? 'border-warn/40 bg-warn/10 text-warn'
          : tone === 'fail'
            ? 'border-fail/40 bg-fail/10 text-fail'
            : 'border-border text-muted-foreground';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider rounded-sm border',
        cls
      )}
    >
      {(status === 'busy' || status === 'creating') && <span className="live-dot mr-0.5" />}[
      {status}]
    </span>
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
