'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  Play,
  RotateCcw,
  RotateCw,
  Search,
} from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { StatusChip } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import type { Actor, Run } from '@/lib/api';
import { getActors, getRunCosts, listRuns, rerunRun } from '@/lib/api';
import { FETCH_ALL_LIMIT, PAGE_SIZE } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';

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

/**
 * Auto-refresh cadence for the runs grid. 5s is the operator-feel sweet
 * spot — fast enough that READY→RUNNING→SUCCEEDED transitions show up
 * within a glance, slow enough that a 5-operator team doesn't bury the
 * runs endpoint. Matches the cadence used on the dashboard home and
 * runners pages (POLL_RUNNERS_MS etc.).
 */
const POLL_RUNS_MS = 5_000;

/** Statuses whose cost is computable — mirrors the /costs endpoint filter. */
const COST_TERMINAL = new Set<Run['status']>(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

/**
 * Statuses the rerun endpoint accepts — exactly the API's guard set.
 * A rerun creates a NEW run and leaves this row terminal, so rows are
 * additionally marked "already rerun" in-session (rerunDoneIds) to keep
 * a double-click from cloning twice.
 */
const RERUNNABLE = new Set<Run['status']>(['FAILED', 'TIMED-OUT', 'ABORTED']);

/**
 * Bulk-rerun candidates on the visible page, at most one per lineage
 * chain.
 *
 * The API allows exactly one active clone per chain, so firing at both
 * an origin and its own failed rerun (both terminal, both on this page)
 * guarantees a `409 rerun-already-active` for the second — a real
 * request reported to the operator as a failure they can do nothing
 * about. Chains are collapsed server-side, so `originRunId ?? id` IS the
 * chain key; keep the first row per key. The list is ordered
 * most-recent-first, so that's the newest attempt — the one whose input
 * is least likely to have been reaped.
 *
 * Note the bulk button only renders under the "failed" filter, which is
 * FAILED + TIMED-OUT (see STATUS_GROUPS). ABORTED is rerunnable per-row
 * but deliberately has no bulk path: aborts are operator decisions, and
 * un-aborting a batch by accident is not a recovery action.
 */
function bulkRerunTargets(rows: Run[], doneIds: Set<string>): Run[] {
  const seenChains = new Set<string>();
  return rows.filter((r) => {
    if (!RERUNNABLE.has(r.status) || doneIds.has(r.id)) return false;
    const chain = r.originRunId ?? r.id;
    if (seenChains.has(chain) || doneIds.has(chain)) return false;
    seenChains.add(chain);
    return true;
  });
}

/**
 * Compact per-row cost. undefined = not loaded (or not applicable),
 * null = not recorded — both render as a muted "—"; the detail page
 * carries the full breakdown and the "not recorded" explanation.
 */
function fmtCost(v: number | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  if (v === 0) return '$0';
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export default function RunsPage() {
  const toast = useToast();
  const confirm = useConfirm();
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
  const [costs, setCosts] = useState<Record<string, number | null>>({});
  // Rerun bookkeeping: in-flight ids (spinner + disabled) and ids already
  // rerun this session (the origin row STAYS terminal after a rerun —
  // without the mark, nothing on the row would show it was handled).
  const [rerunningIds, setRerunningIds] = useState<Set<string>>(new Set());
  const [rerunDoneIds, setRerunDoneIds] = useState<Set<string>>(new Set());
  // Bulk rerun progress; null = idle. Drives the header button's label.
  const [bulkRerun, setBulkRerun] = useState<{ done: number; total: number } | null>(null);
  // Ids we've already asked the /costs endpoint about, so the 5s poll only
  // fetches newly-finished runs. A terminal run's cost is a one-shot fetch:
  // it can drift slightly while droplet siblings are still running, but the
  // table is triage — the detail page recomputes fresh on every view.
  const costAskedRef = useRef<Set<string>>(new Set());

  /**
   * Status groups span multiple raw statuses (e.g. "running" = RUNNING|READY).
   * The API filters one status at a time, so for a multi-status group we fan
   * out and sum totals. The result is one page (the first matching status's
   * page) — operators rarely need cross-status pagination, and when they do
   * they can pick the specific status.
   */
  /**
   * Fetch the current page.
   *
   * `silent` suppresses the global `loading` flag — used by the 5s
   * auto-refresh interval. Without it, every polling tick flashes the
   * entire grid to the `[ LOADING · · · ]` placeholder for the duration
   * of the network round-trip, which is jarring at the operator's eye
   * level (flagged on PR #53 by gemini-code-assist). Initial mount and
   * filter-change still pass `silent=false` so the operator gets visible
   * feedback on the calls they actually initiated.
   */
  async function loadPage(group: StatusGroup, off: number, silent = false) {
    if (!silent) setLoading(true);
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
    } catch (err) {
      if (!silent) {
        toast.error('Failed to load runs', {
          description: err instanceof Error ? err.message : 'Could not query run history',
        });
      }
    } finally {
      if (!silent) setLoading(false);
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
   * Full refresh: page + status-chip counts + actor metadata.
   *
   * Used by the explicit "refresh" affordance and the filter-change
   * effect — NOT the 5s polling tick. The polling tick uses
   * `pollTick` below, which is intentionally narrower.
   *
   * `silent` is forwarded to `loadPage` so callers that don't want the
   * global `loading` flag flipped (e.g. background revalidation) can
   * suppress the LOADING placeholder render.
   */
  async function refresh(silent = false) {
    try {
      await Promise.all([loadPage(statusFilter, offset, silent), loadCounts(), loadActors()]);
    } catch (err) {
      toast.error('Failed to refresh runs', {
        description: err instanceof Error ? err.message : 'Could not query run data',
      });
    }
  }

  /**
   * Narrow tick used by the 5s auto-refresh interval. Re-fetches only
   * what the operator is actively watching — the runs page.
   *
   * Pre-v1.0 the polling tick called `refresh(silent=true)`, which fans
   * out into ~10 requests per tick: 1 page + 8 status-count COUNTs +
   * 1 large actor-metadata fetch. At a 5-operator team that's 600
   * req/min on `/v2/actor-runs` for data that mostly doesn't change.
   *
   * Trade-off: status-chip counts and actor titles stay at their
   * last-loaded values until the next mount / filter-change /
   * explicit refresh. For an ops console where the operator is
   * watching the runs table for new rows and status transitions,
   * 5-second-stale chip counts are fine. Actor titles change on the
   * order of minutes-to-hours (push-driven), not seconds.
   */
  async function pollTick() {
    await loadPage(statusFilter, offset, /* silent */ true);
  }

  /**
   * Mark a rerun as handled, under BOTH the row's id and its chain key.
   * The chain key keeps sibling rows of the same lineage (an origin and
   * its failed rerun, both terminal and both on this page) out of a
   * later bulk run, where they'd only earn a 409 rerun-already-active.
   */
  function markRerunDone(run: Run) {
    setRerunDoneIds((prev) => new Set(prev).add(run.id).add(run.originRunId ?? run.id));
  }

  async function handleRerunOne(run: Run) {
    const id = run.id;
    const ok = await confirm({
      title: 'Rerun this run?',
      description:
        'Starts a NEW run with the same input and settings. This row stays as the failure record.',
      confirmLabel: 'rerun',
    });
    if (!ok) return;
    setRerunningIds((prev) => new Set(prev).add(id));
    try {
      await rerunRun(id);
      markRerunDone(run);
      toast.success('Rerun started');
      // Silent reload so the new READY run shows up now, not at the next
      // 5s tick (visible under "All" / "Running"; this row is unchanged).
      await Promise.all([loadPage(statusFilter, offset, true), loadCounts()]);
    } catch (err) {
      toast.error('Failed to rerun', { description: (err as Error).message });
    } finally {
      setRerunningIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleRerunAllFailed() {
    const targets = bulkRerunTargets(filtered, rerunDoneIds);
    if (targets.length === 0) return;
    const ok = await confirm({
      tone: 'warn',
      title: `Rerun ${targets.length} failed run${targets.length === 1 ? '' : 's'}?`,
      description:
        'Each gets a NEW run with its original input and settings. Scoped to the runs visible on this page — other pages are untouched.',
      confirmLabel: `rerun ${targets.length}`,
    });
    if (!ok) return;
    setBulkRerun({ done: 0, total: targets.length });
    const failures: string[] = [];
    // Sequential on purpose: ≤PAGE_SIZE body-less POSTs finish in seconds,
    // each publish independently wakes the runners, and sequencing avoids
    // hammering the API with a 50-request burst.
    for (const run of targets) {
      try {
        await rerunRun(run.id);
        markRerunDone(run);
      } catch {
        failures.push(run.id);
      }
      setBulkRerun((p) => (p ? { ...p, done: p.done + 1 } : p));
    }
    setBulkRerun(null);
    if (failures.length === 0) {
      toast.success(`Started ${targets.length} rerun${targets.length === 1 ? '' : 's'}`);
    } else {
      toast.error(`${failures.length} of ${targets.length} reruns failed`, {
        description: `e.g. ${failures
          .slice(0, 3)
          .map((id) => id.slice(0, 12))
          .join(', ')} — input may be reaped or a rerun of that run is already active.`,
      });
    }
    await Promise.all([loadPage(statusFilter, offset, true), loadCounts()]);
  }

  // First mount: kick off counts + actors. Page load happens via the
  // status-filter effect, which fires on mount with the default 'all' filter.
  useEffect(() => {
    void Promise.all([loadCounts(), loadActors()]).catch((err: unknown) => {
      toast.error('Failed to load run filters', {
        description: err instanceof Error ? err.message : 'Could not query run metadata',
      });
    });
  }, [toast]);

  // Status filter changed (or initial mount): jump to page 0 and refetch.
  useEffect(() => {
    void loadPage(statusFilter, 0);
  }, [statusFilter]);

  // Live updates: re-fetch the current page every POLL_RUNS_MS via
  // pollTick (narrow — page only, no count fan-out, no actor metadata).
  // The interval calls through a ref so it always invokes the latest
  // `pollTick` (which closes over current `statusFilter` and `offset`)
  // without needing to be recreated on every render. Putting `pollTick`
  // directly in deps would tear down and rebuild the interval on every
  // state change — fine, but noisier; the ref form is the idiomatic
  // React 18+ pattern for stable timers over changing state.
  const pollTickRef = useRef(pollTick);
  useEffect(() => {
    pollTickRef.current = pollTick;
  });
  useEffect(() => {
    const id = setInterval(() => {
      void pollTickRef.current();
    }, POLL_RUNS_MS);
    return () => clearInterval(id);
  }, []);

  // Cost decoration: after every page load / poll tick, batch-fetch costs
  // for visible terminal runs we haven't asked about yet — one request per
  // new batch, nothing when the page is quiet. Failures un-mark the ids so
  // the next tick retries; cells just stay "—" meanwhile.
  useEffect(() => {
    const wanted = items
      .filter((r) => COST_TERMINAL.has(r.status) && !costAskedRef.current.has(r.id))
      .map((r) => r.id);
    if (wanted.length === 0) return;
    wanted.forEach((id) => costAskedRef.current.add(id));
    getRunCosts(wanted)
      .then((map) => {
        setCosts((prev) => {
          const next = { ...prev };
          for (const id of wanted) next[id] = map[id]?.yourCostUsd ?? null;
          return next;
        });
      })
      .catch(() => {
        wanted.forEach((id) => costAskedRef.current.delete(id));
      });
  }, [items]);

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

  // Bulk-rerun candidates on the visible page. Drives both the button's
  // visibility (failed filter only) and its count label, so the bounded
  // "this page only" scope is explicit before the confirm even opens.
  // Same chain-deduped list the handler fires, so the label never
  // promises more reruns than actually get sent.
  const rerunnableOnPage = bulkRerunTargets(filtered, rerunDoneIds).length;

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
          {statusFilter === 'failed' && rerunnableOnPage > 0 && (
            <button
              type="button"
              onClick={() => void handleRerunAllFailed()}
              disabled={bulkRerun !== null || loading}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-warn/40 text-warn hover:bg-warn/10 rounded-sm disabled:opacity-50"
            >
              <RotateCcw className={cn('h-3.5 w-3.5', bulkRerun && 'animate-spin')} />
              {bulkRerun
                ? `rerunning ${bulkRerun.done}/${bulkRerun.total}`
                : `rerun failed (${rerunnableOnPage})`}
            </button>
          )}
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
                <th className="px-5 py-2 font-normal text-right">Items</th>
                <th className="px-5 py-2 font-normal text-right">Cost</th>
                <th className="px-5 py-2 font-normal text-right">Started</th>
                {/* Header-less actions column: cells render a rerun button
                    only on terminal-failed rows, so the column reads as
                    negative space everywhere else. Always visible (no
                    hover-reveal) — touch devices have no hover. */}
                <th className="px-2 py-2 font-normal w-10" aria-label="Actions" />
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
                      <span className="inline-flex items-center gap-1">
                        <AppLink
                          href={`/runs/${run.id}`}
                          className="text-foreground hover:text-signal"
                        >
                          {run.id.slice(0, 12)}
                        </AppLink>
                        <CopyButton value={run.id} label="Run ID" />
                      </span>
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
                    <td className="px-5 py-3 font-mono text-[11px] tnum text-right">
                      {/* Item count is the cell content; click navigates
                          to the dataset (per user request). Three states:
                            - no default dataset            → muted "—"
                            - dataset present, count known  → linked count
                            - dataset present, count = null → "?" (dataset
                              was deleted out-of-band; still link so the
                              user can verify) */}
                      {run.defaultDatasetId ? (
                        <AppLink
                          href={`/datasets/${run.defaultDatasetId}`}
                          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 justify-end"
                        >
                          <Database className="h-3 w-3" />
                          {run.defaultDatasetItemCount != null
                            ? run.defaultDatasetItemCount.toLocaleString()
                            : '?'}
                        </AppLink>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] tnum text-right">
                      {/* Your-cost only; "—" covers running (no cost yet),
                          not-yet-loaded, and never-recorded alike — the
                          detail page's cost card explains which. */}
                      {fmtCost(costs[run.id]) ?? (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground tnum text-right">
                      {/* startedAt is stamped at claim (queue wait excluded);
                          a READY run has no start yet — show queued-since
                          off createdAt instead of mislabeling creation as
                          the start. */}
                      {run.startedAt && run.status !== 'READY' ? (
                        timeAgo(run.startedAt)
                      ) : (
                        <span title={`created ${timeAgo(run.createdAt)}`}>queued</span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-center">
                      {RERUNNABLE.has(run.status) &&
                        (rerunDoneIds.has(run.id) ? (
                          // The origin row stays terminal after a rerun; the
                          // check is the only signal it was already handled.
                          <span title="Rerun already started this session">
                            <Check className="h-3.5 w-3.5 inline text-signal/60" />
                          </span>
                        ) : (
                          <button
                            type="button"
                            title="Rerun with same input"
                            disabled={rerunningIds.has(run.id)}
                            onClick={() => void handleRerunOne(run)}
                            className="p-1 text-muted-foreground hover:text-signal disabled:opacity-40 align-middle"
                          >
                            <RotateCcw
                              className={cn(
                                'h-3.5 w-3.5',
                                rerunningIds.has(run.id) && 'animate-spin'
                              )}
                            />
                          </button>
                        ))}
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
