'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Hammer, Plus, Webhook, Zap } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { StatusChip } from '@/components/ui/badge';
import type { Actor, Run } from '@/lib/api';
import { getActors, getDashboardStats, getRuns } from '@/lib/api';
import { cn } from '@/lib/utils';

type Stats = Awaited<ReturnType<typeof getDashboardStats>>;

export default function ConsolePage() {
  const [stats, setStats] = useState<Stats>({
    totalRuns: 0,
    activeActors: 0,
    totalDatasets: 0,
    successRate: 0,
    runningCount: 0,
    failedLast24h: 0,
  });
  const [runs, setRuns] = useState<Run[]>([]);
  // Actor lookup so we can show names instead of opaque IDs in the feed.
  const [actorsById, setActorsById] = useState<Record<string, Actor>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [s, r, a] = await Promise.all([
          getDashboardStats(),
          getRuns(),
          getActors().catch(() => [] as Actor[]),
        ]);
        if (!alive) return;
        setStats(s);
        setRuns(r);
        const map: Record<string, Actor> = {};
        a.forEach((x) => (map[x.id] = x));
        setActorsById(map);
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  /*
    A 24-bucket hourly histogram of runs over the last 24h.
    Plain CSS bars — no chart library — keeps the page tiny and the aesthetic crisp.
  */
  const histogram = useMemo(() => {
    const now = Date.now();
    const buckets = new Array(24).fill(0).map((_, i) => ({
      hour: i,
      total: 0,
      failed: 0,
    }));
    for (const r of runs) {
      const t = new Date(r.createdAt).getTime();
      const ago = now - t;
      if (ago < 0 || ago > 24 * 60 * 60 * 1000) continue;
      const idx = 23 - Math.floor(ago / (60 * 60 * 1000));
      if (idx < 0 || idx > 23) continue;
      buckets[idx].total += 1;
      if (r.status === 'FAILED' || r.status === 'TIMED-OUT') buckets[idx].failed += 1;
    }
    const max = Math.max(1, ...buckets.map((b) => b.total));
    return { buckets, max };
  }, [runs]);

  const recent = runs.slice(0, 8);

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex items-end justify-between gap-6 pb-4 border-b border-border">
        <div>
          <p className="eyebrow mb-2">CONSOLE · OVERVIEW</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight">
            Operator dashboard
          </h1>
          <p className="text-muted-foreground mt-2 text-[13px]">
            Live state of the Crawlee Cloud cluster — runs, builds, and integrations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AppLink
            href="/actors/new"
            className="inline-flex items-center gap-1.5 px-3 h-8 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/50 hover:text-signal transition-colors rounded-sm"
          >
            <Plus className="h-3.5 w-3.5" /> New actor
          </AppLink>
          <AppLink
            href="/runs/new"
            className="inline-flex items-center gap-1.5 px-3 h-8 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm"
          >
            <Zap className="h-3.5 w-3.5" /> Start run
          </AppLink>
        </div>
      </div>

      {/* Stat strip — six tiles, monospaced numbers, corner brackets */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-border border border-border rounded-md overflow-hidden">
        <Stat label="Actors" value={stats.activeActors} loading={loading} />
        <Stat label="Runs · total" value={stats.totalRuns} loading={loading} />
        <Stat
          label="Running now"
          value={stats.runningCount}
          loading={loading}
          tone={stats.runningCount > 0 ? 'signal' : undefined}
          live={stats.runningCount > 0}
        />
        <Stat
          label="Success · all-time"
          value={stats.totalRuns ? `${stats.successRate}%` : '—'}
          loading={loading}
          tone={
            stats.totalRuns === 0
              ? undefined
              : stats.successRate >= 90
                ? 'signal'
                : stats.successRate >= 70
                  ? 'warn'
                  : 'fail'
          }
        />
        <Stat
          label="Failed · 24h"
          value={stats.failedLast24h}
          loading={loading}
          tone={stats.failedLast24h > 0 ? 'fail' : undefined}
        />
        <Stat label="Datasets" value={stats.totalDatasets} loading={loading} />
      </div>

      {/* Histogram + recent runs side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="panel p-5 lg:col-span-2">
          <header className="flex items-end justify-between mb-5">
            <div>
              <p className="eyebrow">RUNS · LAST 24H</p>
              <h2 className="text-base mt-1">Hourly throughput</h2>
            </div>
            <div className="flex items-center gap-3 font-mono text-[10px] tracking-widest text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-sm bg-signal" /> OK
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-sm bg-fail" /> FAIL
              </span>
            </div>
          </header>

          <div className="h-32 flex items-end gap-[3px]">
            {histogram.buckets.map((b, i) => {
              const h =
                b.total === 0 ? 2 : Math.max(2, Math.round((b.total / histogram.max) * 100));
              const failedH = b.total === 0 ? 0 : Math.round((b.failed / b.total) * h);
              return (
                <div
                  key={i}
                  title={`${24 - i}h ago — ${b.total} runs (${b.failed} failed)`}
                  className="flex-1 flex flex-col-reverse min-w-0 group"
                >
                  <div
                    style={{ height: `${h}%` }}
                    className="bg-signal/30 group-hover:bg-signal/60 transition-colors relative"
                  >
                    {failedH > 0 && (
                      <div
                        style={{ height: `${failedH}%` }}
                        className="absolute inset-x-0 top-0 bg-fail/70"
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-2 font-mono text-[9px] tracking-wider text-muted-foreground">
            <span>−24H</span>
            <span>−18H</span>
            <span>−12H</span>
            <span>−6H</span>
            <span>NOW</span>
          </div>
        </section>

        {/* Quick actions panel */}
        <section className="panel p-5">
          <p className="eyebrow mb-4">QUICK · ACTIONS</p>
          <ul className="space-y-1.5">
            <QuickAction href="/actors/new" icon={Plus} label="New actor" hint="define & deploy" />
            <QuickAction href="/builds" icon={Hammer} label="Recent builds" hint="image · digest" />
            <QuickAction
              href="/webhooks"
              icon={Webhook}
              label="Manage webhooks"
              hint="event delivery"
            />
            <QuickAction
              href="/datasets"
              icon={ArrowUpRight}
              label="Browse datasets"
              hint="output records"
            />
          </ul>
        </section>
      </div>

      {/* Recent runs table */}
      <section className="panel">
        <header className="flex items-end justify-between px-5 py-4 border-b border-border">
          <div>
            <p className="eyebrow">FEED · RUNS</p>
            <h2 className="text-base mt-1">Recent activity</h2>
          </div>
          <AppLink
            href="/runs"
            className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          >
            view all →
          </AppLink>
        </header>

        {recent.length === 0 ? (
          <div className="grid-bg p-12 text-center">
            <p className="font-mono text-[11px] tracking-wider text-muted-foreground">
              [ NO RUNS YET ]
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              Start a run from an actor page or via{' '}
              <code className="font-mono text-foreground">crc run</code>.
            </p>
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-widest text-muted-foreground uppercase border-b border-border">
                <th className="px-5 py-2 font-normal">Run ID</th>
                <th className="px-5 py-2 font-normal">Actor</th>
                <th className="px-5 py-2 font-normal">Status</th>
                <th className="px-5 py-2 font-normal text-right">Started</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((run) => (
                <tr
                  key={run.id}
                  className="border-b border-border/60 last:border-0 hover:bg-secondary/40 transition-colors"
                >
                  <td className="px-5 py-3 font-mono">
                    <AppLink
                      href={`/runs/${run.id}`}
                      className="text-foreground hover:text-signal transition-colors"
                    >
                      {run.id.slice(0, 12)}
                    </AppLink>
                  </td>
                  <td className="px-5 py-3">
                    {(() => {
                      const actor = actorsById[run.actId];
                      return actor ? (
                        <AppLink
                          href={`/actors/${actor.name}`}
                          className="text-foreground hover:text-signal text-[13px]"
                        >
                          {actor.title || actor.name}
                        </AppLink>
                      ) : (
                        <span className="text-muted-foreground/50 italic text-[12px]">
                          deleted actor
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-5 py-3">
                    <StatusChip status={run.status} />
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground tnum text-right">
                    {timeAgo(run.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  loading,
  tone,
  live,
}: {
  label: string;
  value: number | string;
  loading: boolean;
  tone?: 'signal' | 'warn' | 'fail';
  live?: boolean;
}) {
  const toneClass =
    tone === 'signal'
      ? 'text-signal'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'fail'
          ? 'text-fail'
          : 'text-foreground';
  return (
    <div className="bg-card px-5 py-4 relative">
      <div className="flex items-center justify-between mb-2">
        <span className="eyebrow">{label}</span>
        {live && <span className="live-dot" />}
      </div>
      <div className={cn('text-2xl font-mono tnum tracking-tight leading-none', toneClass)}>
        {loading ? <span className="text-muted-foreground/40">…</span> : value}
      </div>
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
  hint,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
}) {
  return (
    <li>
      <AppLink
        href={href}
        className="group flex items-center gap-3 px-3 py-2.5 border border-transparent hover:border-border hover:bg-secondary/40 rounded-sm transition-colors"
      >
        <Icon className="h-3.5 w-3.5 text-muted-foreground group-hover:text-signal" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] text-foreground leading-none">{label}</p>
          <p className="font-mono text-[10px] text-muted-foreground tracking-wider mt-1 leading-none">
            {hint}
          </p>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground/60 group-hover:text-foreground">
          →
        </span>
      </AppLink>
    </li>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
