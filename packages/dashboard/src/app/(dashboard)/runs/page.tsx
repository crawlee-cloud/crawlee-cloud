'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Database,
  Play,
  RotateCw,
  Search,
} from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { StatusChip } from '@/components/ui/badge';
import type { Actor, Run } from '@/lib/api';
import { getActors, listRuns } from '@/lib/api';
import { FETCH_ALL_LIMIT, PAGE_SIZE } from '@/lib/constants';
import { cn } from '@/lib/utils';

/*
  Server-paginated runs triage.

  At the platform's target scale (~280 runs/day × N users), the runs table
  grows fast enough that client-side fetch-everything-then-filter would lie
  to the operator about what they're seeing past the first page. So:

    - status filter         → server-side (indexed, returns real total)
    - pagination (prev/next)→ server-side (offset + limit)
    - search box            → client-side, scoped to the current page
                              and labeled as such, to set the right
                              expectation
    - status counts         → one COUNT query per group, in parallel

  The page header always surfaces "showing X–Y of Z" so a half-loaded view
  can't be mistaken for "all the data".
*/

type StatusGroup = 'all' | 'running' | 'succeeded' | 'failed' | 'aborted';

const STATUS_GROUPS: Record<Exclude<StatusGroup, 'all'>, Run['status'][]> = {
  running: ['RUNNING', 'READY'],
  succeeded: ['SUCCEEDED'],
  failed: ['FAILED', 'TIMED-OUT'],
  aborted: ['ABORTING', 'ABORTED'],
};

export default function RunsPage() {
  const [items, setItems] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [counts, setCounts] = useState<Record<StatusGroup, number>>({
    all: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    aborted: 0,
  });
  const [actors, setActors] = useState<Record<string, Actor>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusGroup>('all');

  /**
   * Status groups span multiple raw statuses (e.g. "running" = RUNNING|READY).
   * The API filters one status at a time, so for a multi-status group we fan
   * out and sum totals. The result is one page (the first matching status's
   * page) — operators rarely need cross-status pagination, and when they do
   * they can pick the specific status.
   */
  async function loadPage(group: StatusGroup, off: number) {
    setLoading(true);
    try {
      if (group === 'all') {
        const page = await listRuns({ limit: PAGE_SIZE, offset: off });
        setItems(page.items);
        setTotal(page.total);
        setOffset(page.offset);
      } else {
        const statuses = STATUS_GROUPS[group];
        const pages = await Promise.all(
          statuses.map((s) => listRuns({ status: s, limit: PAGE_SIZE, offset: off }))
        );
        // Merge multi-status pages by created_at desc, take first PAGE_SIZE.
        const merged = pages
          .flatMap((p) => p.items)
          .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
          .slice(0, PAGE_SIZE);
        setItems(merged);
        setTotal(pages.reduce((acc, p) => acc + p.total, 0));
        setOffset(off);
      }
    } finally {
      setLoading(false);
    }
  }

  /** One lightweight COUNT request per chip — limit=1 keeps the page payload tiny. */
  async function loadCounts() {
    const allP = listRuns({ limit: 1 });
    const groupPs: Array<Promise<{ key: StatusGroup; total: number }>> = (
      Object.entries(STATUS_GROUPS) as Array<[Exclude<StatusGroup, 'all'>, Run['status'][]]>
    ).map(async ([key, statuses]) => {
      const subs = await Promise.all(statuses.map((s) => listRuns({ status: s, limit: 1 })));
      return { key, total: subs.reduce((acc, p) => acc + p.total, 0) };
    });
    const [all, ...groups] = await Promise.all([allP, ...groupPs]);
    const next: Record<StatusGroup, number> = {
      all: all.total,
      running: 0,
      succeeded: 0,
      failed: 0,
      aborted: 0,
    };
    for (const g of groups) next[g.key] = g.total;
    setCounts(next);
  }

  async function loadActors() {
    const a = await getActors({ limit: FETCH_ALL_LIMIT });
    const map: Record<string, Actor> = {};
    a.items.forEach((x) => (map[x.id] = x));
    setActors(map);
  }

  /**
   * Refresh: counts + actors + (the status-filter effect picks up the page).
   * The page itself is loaded by the status-filter useEffect below — keeping
   * loadPage out of refresh() avoids a duplicate first-load request.
   */
  async function refresh() {
    await Promise.all([loadPage(statusFilter, offset), loadCounts(), loadActors()]);
  }

  // First mount: kick off counts + actors. Page load happens via the
  // status-filter effect, which fires on mount with the default 'all' filter.
  useEffect(() => {
    void Promise.all([loadCounts(), loadActors()]);
  }, []);

  // Status filter changed (or initial mount): jump to page 0 and refetch.
  useEffect(() => {
    void loadPage(statusFilter, 0);
  }, [statusFilter]);

  const q = search.trim().toLowerCase();
  // In-page search only — labelled as such so the operator knows it doesn't
  // span the whole result set.
  const filtered = useMemo(() => {
    if (!q) return items;
    return items.filter((run) => {
      const actor = actors[run.actId];
      const haystack = [run.id, run.actId, actor?.name ?? '', actor?.title ?? '']
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [items, actors, q]);

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + items.length, total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6 pb-4 border-b border-border">
        <div>
          <p className="eyebrow mb-2">RUN · HISTORY</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Runs</h1>
          <p className="text-muted-foreground mt-2 text-[13px]">
            Execution history across every actor.
            {total > 0 && (
              <>
                {' '}
                <span className="font-mono text-[12px]">
                  showing {pageStart}–{pageEnd} of {total.toLocaleString()}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/40 hover:text-signal rounded-sm disabled:opacity-50"
          >
            <RotateCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> refresh
          </button>
          <AppLink
            href="/runs/new"
            className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm"
          >
            <Play className="h-3.5 w-3.5" /> start run
          </AppLink>
        </div>
      </div>

      {/* Filter bar — search is in-page only; status chips drive the server query. */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search the current page (id / actor)"
            className="w-full h-9 pl-9 pr-3 rounded-sm border border-border bg-input text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-signal/50"
          />
        </div>
        <div className="flex items-center gap-1 overflow-x-auto">
          {(
            [
              { id: 'all', label: 'All', tone: '' },
              { id: 'running', label: 'Running', tone: 'info' },
              { id: 'succeeded', label: 'Succeeded', tone: 'signal' },
              { id: 'failed', label: 'Failed', tone: 'fail' },
              { id: 'aborted', label: 'Aborted', tone: 'warn' },
            ] as {
              id: StatusGroup;
              label: string;
              tone: '' | 'info' | 'signal' | 'fail' | 'warn';
            }[]
          ).map((f) => {
            const isOn = statusFilter === f.id;
            const count = counts[f.id];
            const toneActive =
              f.tone === 'info'
                ? 'border-info/50 bg-info/10 text-info'
                : f.tone === 'signal'
                  ? 'border-signal/50 bg-signal/10 text-signal'
                  : f.tone === 'fail'
                    ? 'border-fail/50 bg-fail/10 text-fail'
                    : f.tone === 'warn'
                      ? 'border-warn/50 bg-warn/10 text-warn'
                      : 'border-border bg-secondary text-foreground';
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={cn(
                  'h-8 px-3 inline-flex items-center gap-2 text-[12px] font-mono uppercase tracking-wider rounded-sm border transition-colors shrink-0',
                  isOn
                    ? toneActive
                    : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                )}
              >
                <span>{f.label}</span>
                <span className="font-mono text-[10px] tnum opacity-70">
                  {count.toLocaleString()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <section className="panel">
        {loading ? (
          <div className="grid-bg p-12 text-center">
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              [ LOADING · · · ]
            </p>
          </div>
        ) : items.length === 0 ? (
          <div className="grid-bg p-16 text-center">
            <Activity className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              [ NO RUNS YET ]
            </p>
            <p className="text-[13px] text-muted-foreground mt-2">
              Start your first run from an actor page or via{' '}
              <code className="font-mono text-foreground">crc run</code>.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="grid-bg p-16 text-center">
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              [ NO MATCH ON THIS PAGE ]
            </p>
            <p className="text-[13px] text-muted-foreground mt-2">
              Nothing on this page matches &ldquo;{search}&rdquo;
              {' · '}
              <button
                type="button"
                onClick={() => setSearch('')}
                className="text-signal hover:underline font-mono text-[12px]"
              >
                clear search
              </button>
              {canNext && (
                <>
                  {' or '}
                  <button
                    type="button"
                    onClick={() => void loadPage(statusFilter, offset + PAGE_SIZE)}
                    className="text-signal hover:underline font-mono text-[12px]"
                  >
                    next page
                  </button>
                </>
              )}
            </p>
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-widest text-muted-foreground uppercase border-b border-border">
                <th className="px-5 py-2 font-normal">Run</th>
                <th className="px-5 py-2 font-normal">Actor</th>
                <th className="px-5 py-2 font-normal">Status</th>
                <th className="px-5 py-2 font-normal">Duration</th>
                <th className="px-5 py-2 font-normal">Dataset</th>
                <th className="px-5 py-2 font-normal text-right">Started</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((run) => {
                const actor = actors[run.actId];
                return (
                  <tr
                    key={run.id}
                    className="border-b border-border/60 last:border-0 hover:bg-secondary/40"
                  >
                    <td className="px-5 py-3 font-mono">
                      <AppLink
                        href={`/runs/${run.id}`}
                        className="text-foreground hover:text-signal"
                      >
                        {run.id.slice(0, 12)}
                      </AppLink>
                    </td>
                    <td className="px-5 py-3">
                      {actor ? (
                        <AppLink
                          href={`/actors/${actor.name}`}
                          className="text-muted-foreground hover:text-foreground font-mono text-[12px]"
                        >
                          {actor.title || actor.name}
                        </AppLink>
                      ) : (
                        <span className="text-muted-foreground/50 italic text-[12px]">deleted</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <StatusChip status={run.status} />
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground tnum">
                      {fmtDuration(run.startedAt, run.finishedAt)}
                    </td>
                    <td className="px-5 py-3">
                      {run.defaultDatasetId ? (
                        <AppLink
                          href={`/datasets/${run.defaultDatasetId}`}
                          className="font-mono text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                        >
                          <Database className="h-3 w-3" />
                          {run.defaultDatasetId.slice(0, 10)}
                        </AppLink>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground tnum text-right">
                      {timeAgo(run.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Pagination footer — only renders when there's a real page boundary
            to cross. Buttons disable themselves at the edges. */}
        {(canPrev || canNext) && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border/60 text-[12px] font-mono text-muted-foreground">
            <span>
              {pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadPage(statusFilter, Math.max(0, offset - PAGE_SIZE))}
                disabled={!canPrev || loading}
                className="h-8 px-3 inline-flex items-center gap-1 border border-border rounded-sm hover:border-signal/40 hover:text-signal disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> prev
              </button>
              <button
                type="button"
                onClick={() => void loadPage(statusFilter, offset + PAGE_SIZE)}
                disabled={!canNext || loading}
                className="h-8 px-3 inline-flex items-center gap-1 border border-border rounded-sm hover:border-signal/40 hover:text-signal disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
              >
                next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function fmtDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const s = Math.floor((end - start) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
