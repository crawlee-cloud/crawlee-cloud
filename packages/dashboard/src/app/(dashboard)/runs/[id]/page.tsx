'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Ban,
  Boxes,
  Clock,
  Cpu,
  Database,
  FileInput,
  ListOrdered,
  Loader2,
  Terminal,
  Webhook as WebhookIcon,
} from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { CostAnalysisCard } from '@/components/cost-analysis-card';
import { StatusChip } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import {
  abortRun,
  downloadAsBlob,
  getActor,
  getRun,
  getRunDatasetItems,
  getRunInput,
  getRunLogs,
  getWebhookDeliveries,
  getWebhooks,
  openInTabAsBlob,
  type Actor,
  type Run,
  type Webhook,
  type WebhookDelivery,
} from '@/lib/api';
import { DATASET_PREVIEW_LIMIT, LOG_TAIL_LIMIT } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';

type Tab = 'logs' | 'input' | 'output' | 'webhooks';

const TERMINAL = new Set<Run['status']>(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

function RunDetail() {
  const params = useParams();
  const id = params.id as string;
  const confirm = useConfirm();
  const toast = useToast();

  const [run, setRun] = useState<Run | null>(null);
  // Resolved actor for display name. Loaded once when run is first known.
  const [actor, setActor] = useState<Actor | null>(null);
  const [logs, setLogs] = useState<{ timestamp: string; level: string; message: string }[]>([]);
  // Total log lines stored server-side (Redis llen). May exceed `logs.length`
  // (we only render the tail 500). Surfaced in UI so operators see "showing
  // 500 of N" honestly — and prompts them to click "View raw" for full log.
  const [logTotal, setLogTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('logs');

  const [input, setInput] = useState<unknown>(undefined); // undefined = not fetched
  const [inputLoading, setInputLoading] = useState(false);
  const [dataset, setDataset] = useState<unknown[] | null>(null); // null = not fetched
  const [datasetLoading, setDatasetLoading] = useState(false);
  // Per-run hooks are immutable post-dispatch — one fetch on run-load is
  // enough. `null` distinguishes "not fetched yet" from "fetched, empty".
  const [runWebhooks, setRunWebhooks] = useState<Webhook[] | null>(null);
  // Deliveries per webhook, lazy-loaded when the Webhooks tab is opened.
  // Keyed by webhook id so multiple hooks can have their delivery history
  // shown simultaneously without re-fetching as the user expands rows.
  const [deliveriesByWebhook, setDeliveriesByWebhook] = useState<Record<string, WebhookDelivery[]>>(
    {}
  );

  const logsEndRef = useRef<HTMLDivElement>(null);

  /*
    Polling — single self-scheduling chain that:
    - reschedules itself only while status is non-terminal
    - cancels cleanly on unmount (timer ref + alive flag)
    - never stacks intervals, so re-renders don't spawn duplicate fetches
  */
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        // tail=true returns the LAST `limit` lines — what operators triaging
        // a failed run need. The API exposes total separately so we can
        // surface "showing 500 of 23,481" honestly. For the full log,
        // operators click "View raw" → streaming download endpoint.
        const [r, l] = await Promise.all([
          getRun(id),
          getRunLogs(id, { limit: LOG_TAIL_LIMIT, tail: true }),
        ]);
        if (!alive) return;
        setRun(r);
        setLogs(l.items || []);
        setLogTotal(l.total ?? l.items.length);
        setLoading(false);
        if (alive && !TERMINAL.has(r.status)) {
          // tick() returns a Promise — wrap in a void-returning callback
          // because setTimeout expects () => void.
          timer = setTimeout(() => {
            void tick();
          }, 2000);
        }
      } catch (err) {
        console.error('Failed to load run', err);
        if (alive) setLoading(false);
      }
    }

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  // Reset run-scoped lazy state when navigating to a different run. The
  // App Router keeps this component mounted across /runs/A -> /runs/B (only
  // the param changes), so without this the "already fetched" guards below
  // (input !== undefined, dataset !== null, runWebhooks !== null) would pin
  // the PREVIOUS run's data on screen forever. Keyed on the route param so
  // the reset lands at navigation time, not after the new run's fetch.
  // `actor` is intentionally NOT reset: it's actor-scoped, not run-scoped —
  // the [actId] effect below refetches it iff the new run targets a
  // different actor, and nulling it here would orphan it when actId is
  // unchanged (same-actor navigation, e.g. retry links).
  useEffect(() => {
    setInput(undefined);
    setDataset(null);
    setRunWebhooks(null);
    setDeliveriesByWebhook({});
  }, [id]);

  // Resolve the actor lazily once we know which one this run targeted.
  // Depend on the stable actId primitive, NOT the `run` object: the 2s
  // poll loop replaces the run reference on every tick, which re-fired
  // this effect (a fresh GET /v2/acts/:id) ~1800×/hour per open tab.
  const actId = run?.actId;
  useEffect(() => {
    if (!actId) return;
    let alive = true;
    getActor(actId)
      .then((a) => alive && setActor(a))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [actId]);

  // Per-run webhooks: fetch once on first load. They can't be mutated after
  // dispatch (PUT is rejected server-side via `run_id IS NULL`), so polling
  // adds no value — only the deliveries can change, and operators see those
  // on /webhooks if they need detail.
  const loadedRunId = run?.id;
  useEffect(() => {
    // `loadedRunId !== id` gate: right after navigation, `run` still holds
    // the PREVIOUS run (its poll hasn't resolved) while the reset effect
    // has already nulled runWebhooks — without the gate this effect would
    // fetch the old run's webhooks and, once stored, the runWebhooks
    // sentinel would block the new run's fetch forever.
    if (!loadedRunId || loadedRunId !== id || runWebhooks !== null) return;
    let alive = true;
    getWebhooks({ scope: 'run', runId: loadedRunId, limit: 50 })
      .then((page) => alive && setRunWebhooks(page.items))
      .catch(() => alive && setRunWebhooks([]));
    return () => {
      alive = false;
    };
  }, [loadedRunId, runWebhooks]);

  // Lazy-load tab data on demand
  useEffect(() => {
    if (tab === 'input' && input === undefined && !inputLoading) {
      setInputLoading(true);
      getRunInput(id)
        .then((d) => setInput(d ?? null))
        .catch(() => setInput(null))
        .finally(() => setInputLoading(false));
    }
    if (tab === 'output' && dataset === null && !datasetLoading) {
      setDatasetLoading(true);
      getRunDatasetItems(id, { limit: DATASET_PREVIEW_LIMIT })
        .then((d) => setDataset(d || []))
        .catch(() => setDataset([]))
        .finally(() => setDatasetLoading(false));
    }
    // Fetch deliveries for every per-run webhook the first time the
    // Webhooks tab is opened. Parallel — webhook count is small (1-3
    // typically). Subsequent tab visits reuse the cached results.
    if (tab === 'webhooks' && runWebhooks && runWebhooks.length > 0) {
      const missing = runWebhooks.filter((w) => !(w.id in deliveriesByWebhook));
      if (missing.length > 0) {
        void Promise.all(
          missing.map((w) =>
            getWebhookDeliveries(w.id)
              .then((items) => [w.id, items] as const)
              .catch(() => [w.id, [] as WebhookDelivery[]] as const)
          )
        ).then((results) => {
          setDeliveriesByWebhook((prev) => {
            const next = { ...prev };
            for (const [id, items] of results) next[id] = items;
            return next;
          });
        });
      }
    }
  }, [tab, id, input, inputLoading, dataset, datasetLoading, runWebhooks, deliveriesByWebhook]);

  // Auto-scroll log tail
  useEffect(() => {
    if (tab === 'logs' && run && !TERMINAL.has(run.status)) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, tab, run]);

  async function handleAbort() {
    const ok = await confirm({
      tone: 'warn',
      title: 'Abort this run?',
      description:
        'The container will be sent SIGTERM and given a short grace period before being killed. Data already written stays.',
      confirmLabel: 'abort run',
    });
    if (!ok) return;
    try {
      await abortRun(id);
      toast.success('Run aborted');
    } catch (err) {
      toast.error('Failed to abort run', { description: (err as Error).message });
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center min-h-[60vh]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!run) {
    return (
      <div className="grid place-items-center min-h-[60vh] text-center">
        <div>
          <p className="font-mono text-[11px] tracking-widest text-muted-foreground mb-3">
            [ RUN NOT FOUND ]
          </p>
          <p className="text-[13px] text-muted-foreground mb-4">
            ID <code className="font-mono text-foreground">{id.slice(0, 16)}</code> doesn&apos;t map
            to any run on this cluster.
          </p>
          <AppLink
            href="/runs"
            className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-mono uppercase tracking-wider border border-border text-muted-foreground hover:text-foreground hover:border-signal/40 rounded-sm"
          >
            ← back to runs
          </AppLink>
        </div>
      </div>
    );
  }

  const isLive = !TERMINAL.has(run.status);
  const tabs: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'logs', label: 'Logs', icon: Terminal },
    { id: 'input', label: 'Input', icon: FileInput },
    { id: 'output', label: 'Output', icon: Database },
    // Show Webhooks tab only when this run actually has per-run hooks.
    // Most runs don't, so a permanent tab would be dead UI on every page.
    // Conditional rendering matches the "negative space = no hooks" pattern
    // — when the tab is absent, no hooks; when present, it's a strong
    // affordance to look there.
    ...((runWebhooks?.length ?? 0) > 0
      ? [{ id: 'webhooks' as Tab, label: 'Webhooks', icon: WebhookIcon }]
      : []),
  ];

  return (
    <div className="space-y-6">
      {/* Crumb */}
      <AppLink
        href="/runs"
        className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
      >
        <ArrowLeft className="h-3 w-3" /> runs
      </AppLink>

      {/* Header strip */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 pb-5 border-b border-border">
        <div className="space-y-2 min-w-0">
          <p className="eyebrow inline-flex items-center gap-1.5">
            RUN · {run.id.slice(0, 12)}
            <CopyButton value={run.id} label="Run ID" />
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-[28px] leading-none font-medium tracking-tight">Execution</h1>
            <StatusChip status={run.status} />
          </div>
          <p className="font-mono text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
            actor ·{' '}
            {actor ? (
              <AppLink href={`/actors/${actor.name}`} className="text-foreground hover:text-signal">
                {actor.title || actor.name}
              </AppLink>
            ) : (
              <AppLink href={`/actors/${run.actId}`} className="text-foreground hover:text-signal">
                {run.actId}
              </AppLink>
            )}
            {/* Copy the ACTOR ID (nanoid) not the slug — the ID is what the
                SDK / API consumers need; slug is for human-readable URLs.
                Falls back to run.actId when the actor resolution hasn't
                completed; same value either way (Actor.id == run.actId). */}
            <CopyButton value={actor?.id ?? run.actId} label="Actor ID" />
          </p>
        </div>
        {isLive && (
          <button
            type="button"
            onClick={() => void handleAbort()}
            className="h-8 px-3 self-start md:self-auto inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-fail/40 text-fail hover:bg-fail/10 rounded-sm"
          >
            <Ban className="h-3.5 w-3.5" /> Abort
          </button>
        )}
      </div>

      {/* Two-column: meta + console */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <aside className="panel p-5 md:col-span-1 space-y-4 h-fit">
          <p className="eyebrow">RUNTIME</p>
          <DefRow icon={Clock} label="Started">
            {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
          </DefRow>
          <DefRow icon={Clock} label="Finished">
            {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'}
          </DefRow>
          <DefRow icon={Cpu} label="Memory">
            {run.options?.memoryMbytes ? `${run.options.memoryMbytes} MB` : '—'}
          </DefRow>
          <DefRow icon={Clock} label="Timeout">
            {run.options?.timeoutSecs ? `${run.options.timeoutSecs}s` : '—'}
          </DefRow>
          {run.defaultDatasetId && (
            <DefRow icon={Database} label="Dataset" copyValue={run.defaultDatasetId}>
              <AppLink
                href={`/datasets/${run.defaultDatasetId}`}
                className="font-mono text-[11px] text-foreground hover:text-signal break-all"
              >
                {run.defaultDatasetId}
              </AppLink>
            </DefRow>
          )}
          {run.defaultKeyValueStoreId && (
            <DefRow icon={Boxes} label="KV store" copyValue={run.defaultKeyValueStoreId}>
              <AppLink
                href={`/key-value-stores/${run.defaultKeyValueStoreId}`}
                className="font-mono text-[11px] text-foreground hover:text-signal break-all"
              >
                {run.defaultKeyValueStoreId}
              </AppLink>
            </DefRow>
          )}
          {run.defaultRequestQueueId && (
            <DefRow icon={ListOrdered} label="Request queue" copyValue={run.defaultRequestQueueId}>
              <AppLink
                href={`/request-queues/${run.defaultRequestQueueId}`}
                className="font-mono text-[11px] text-foreground hover:text-signal break-all"
              >
                {run.defaultRequestQueueId}
              </AppLink>
            </DefRow>
          )}
        </aside>

        <section className="panel md:col-span-3 flex flex-col h-[640px] overflow-hidden">
          <div className="flex border-b border-border bg-secondary/40">
            {tabs.map((t) => {
              const Icon = t.icon;
              const isActive = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'inline-flex items-center gap-2 px-4 h-10 text-[12px] font-mono uppercase tracking-wider transition-colors -mb-px border-b',
                    isActive
                      ? 'text-signal border-signal'
                      : 'text-muted-foreground border-transparent hover:text-foreground'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                  {t.id === 'logs' && isLive && <span className="live-dot ml-1" />}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-hidden relative">
            {tab === 'logs' && (
              <div className="absolute inset-0 overflow-auto p-4 font-mono text-[11px] bg-background/60">
                {/*
                  Tail viewport header: shows what fraction of the full log is
                  currently rendered, plus a "view raw" link that opens the
                  streaming download endpoint in a new tab — same pattern as
                  Apify. Avoids ever rendering 50K+ lines in the DOM.
                */}
                {logTotal > 0 && (
                  <div className="flex items-center justify-between mb-2 pb-2 border-b border-border/40 text-[10px] tracking-wider text-muted-foreground">
                    <span>
                      {logs.length < logTotal
                        ? `showing last ${logs.length.toLocaleString()} of ${logTotal.toLocaleString()} lines`
                        : `${logTotal.toLocaleString()} lines`}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void openInTabAsBlob(
                          `/v2/actor-runs/${id}/logs/raw`,
                          'text/plain; charset=utf-8'
                        ).catch((err) =>
                          toast.error('Could not open raw log', {
                            description: (err as Error).message,
                          })
                        );
                      }}
                      className="inline-flex items-center gap-1 hover:text-signal"
                    >
                      view raw ↗
                    </button>
                  </div>
                )}
                {logs.length === 0 ? (
                  <div className="h-full grid place-items-center text-muted-foreground/60">
                    [ NO LOG OUTPUT ]
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {logs.map((log, i) => (
                      <div
                        key={i}
                        className="flex gap-3 hover:bg-secondary/40 px-1 py-0.5 rounded-sm"
                      >
                        <span className="text-muted-foreground/60 shrink-0 w-[80px] tnum">
                          {new Date(log.timestamp).toISOString().split('T')[1].slice(0, 8)}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 w-[52px] tracking-wider',
                            log.level === 'INFO' && 'text-info',
                            log.level === 'WARN' && 'text-warn',
                            log.level === 'ERROR' && 'text-fail',
                            log.level === 'DEBUG' && 'text-muted-foreground'
                          )}
                        >
                          {log.level}
                        </span>
                        <span className="text-foreground whitespace-pre-wrap break-all">
                          {log.message}
                        </span>
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                )}
              </div>
            )}

            {tab === 'input' && (
              <div className="absolute inset-0 overflow-auto p-4">
                {inputLoading ? (
                  <div className="h-full grid place-items-center">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : input && Object.keys(input as object).length > 0 ? (
                  // Wrap the pre in a relative container so the copy button
                  // can sit in the top-right corner regardless of content
                  // length. Pretty-printed JSON is stored once and reused
                  // for both display and copy — keeps the visible text and
                  // clipboard payload byte-identical.
                  <div className="relative">
                    <pre className="font-mono text-[12px] text-foreground whitespace-pre-wrap p-4 pr-20 border border-border rounded-sm bg-background/60">
                      {JSON.stringify(input, null, 2)}
                    </pre>
                    <div className="absolute top-2 right-2">
                      <CopyButton
                        value={JSON.stringify(input, null, 2)}
                        label="Input JSON"
                        variant="button"
                        title="Copy run input as pretty-printed JSON"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="h-full grid place-items-center text-center">
                    <div>
                      <FileInput className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
                      <p className="font-mono text-[11px] tracking-wider text-muted-foreground">
                        [ NO INPUT ]
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'output' && (
              <div className="absolute inset-0 overflow-auto">
                {datasetLoading || dataset === null ? (
                  <div className="h-full grid place-items-center">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : dataset.length === 0 ? (
                  <div className="h-full grid place-items-center text-center">
                    <div>
                      <Database className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
                      <p className="font-mono text-[11px] tracking-wider text-muted-foreground">
                        [ NO OUTPUT ]
                      </p>
                      <p className="text-[12px] text-muted-foreground mt-1">
                        {isLive
                          ? 'Run is in progress. Records will appear once produced.'
                          : 'This run did not write to the default dataset.'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <DatasetTable items={dataset} />
                )}
              </div>
            )}

            {tab === 'webhooks' && (
              <div className="absolute inset-0 overflow-auto p-4 space-y-3">
                {runWebhooks && runWebhooks.length > 0 ? (
                  runWebhooks.map((w) => (
                    <RunWebhookCard key={w.id} webhook={w} deliveries={deliveriesByWebhook[w.id]} />
                  ))
                ) : (
                  <div className="h-full grid place-items-center text-center">
                    <div>
                      <WebhookIcon className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
                      <p className="font-mono text-[11px] tracking-wider text-muted-foreground">
                        [ NO PER-RUN WEBHOOKS ]
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {tab === 'output' && run.defaultDatasetId && dataset && dataset.length > 0 && (
            <div className="px-4 py-2 border-t border-border bg-secondary/40 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  if (!run.defaultDatasetId) return;
                  void downloadAsBlob(
                    `/v2/datasets/${run.defaultDatasetId}/items?download=1`,
                    `dataset-${run.defaultDatasetId}.json`
                  ).catch((err) =>
                    toast.error('Download failed', {
                      description: (err as Error).message,
                    })
                  );
                }}
                className="font-mono text-[10px] tracking-widest text-muted-foreground hover:text-signal uppercase"
              >
                ↓ download all
              </button>
              <AppLink
                href={`/datasets/${run.defaultDatasetId}`}
                className="font-mono text-[10px] tracking-widest text-muted-foreground hover:text-foreground uppercase"
              >
                view full dataset · {dataset.length} shown →
              </AppLink>
            </div>
          )}
        </section>
      </div>

      {/* key: remount per run so stale cost from a previous run never renders */}
      <CostAnalysisCard key={id} runId={id} status={run.status} />
    </div>
  );
}

function DatasetTable({ items }: { items: unknown[] }) {
  // Pull keys from the first object — pragmatic; matches Apify's dataset shape conventions.
  const sample = (items[0] ?? {}) as Record<string, unknown>;
  const keys = Object.keys(sample).slice(0, 8);
  if (keys.length === 0) {
    // Items aren't objects — render as JSON list
    return (
      <pre className="p-4 font-mono text-[11px] text-foreground whitespace-pre-wrap">
        {JSON.stringify(items, null, 2)}
      </pre>
    );
  }
  return (
    <table className="w-full text-[12px]">
      <thead className="bg-secondary/60 sticky top-0 z-10">
        <tr className="text-left font-mono text-[10px] tracking-widest text-muted-foreground uppercase border-b border-border">
          <th className="px-4 py-2 font-normal w-12 tnum">#</th>
          {keys.map((k) => (
            <th key={k} className="px-4 py-2 font-normal whitespace-nowrap">
              {k}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((it, i) => (
          <tr
            key={i}
            className="border-b border-border/60 last:border-0 hover:bg-secondary/40 align-top"
          >
            <td className="px-4 py-2 font-mono text-[10px] text-muted-foreground tnum">{i + 1}</td>
            {keys.map((k) => {
              const v = (it as Record<string, unknown>)[k];
              const display =
                typeof v === 'object' && v !== null
                  ? JSON.stringify(v)
                  : v === null || v === undefined
                    ? ''
                    : String(v as string | number | boolean | bigint);
              return (
                <td
                  key={k}
                  className="px-4 py-2 font-mono text-[11px] text-foreground max-w-[280px] truncate"
                  title={display}
                >
                  {display}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DefRow({
  icon: Icon,
  label,
  copyValue,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  /**
   * When provided, a small copy-to-clipboard button appears on the right of
   * the label row. Use the same string that the user would want to paste
   * into a curl / SDK call (e.g., the full ID, not its truncated display
   * form). Omit for non-identifier rows (Started / Finished / Memory etc).
   */
  copyValue?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="eyebrow flex items-center gap-1.5">
          <Icon className="h-3 w-3" /> {label}
        </p>
        {copyValue && <CopyButton value={copyValue} label={label} />}
      </div>
      <p className="text-[12px] text-foreground">{children}</p>
    </div>
  );
}

/**
 * Full-detail card for one per-run webhook on the run page's Webhooks tab.
 * Focused on debug-by-evidence: the rendered request body (what we sent)
 * is the centerpiece, paired with the response (what came back) for each
 * delivery attempt. Headers are kept inline at the top; the configured
 * template is only shown as a fallback when no deliveries exist yet
 * (because once a delivery exists, the rendered body is strictly more
 * useful than the unresolved template).
 *
 * Read-only: editing/deletion lives on /webhooks.
 */
function RunWebhookCard({
  webhook,
  deliveries,
}: {
  webhook: Webhook;
  deliveries: WebhookDelivery[] | undefined;
}) {
  return (
    <article className="panel">
      <header className="px-4 py-3 border-b border-border space-y-2">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'shrink-0 font-mono text-[10px] tracking-widest px-1.5 py-0.5 rounded-sm border',
              webhook.isEnabled
                ? 'text-signal border-signal/40'
                : 'text-muted-foreground border-border'
            )}
          >
            {webhook.isEnabled ? '[LIVE]' : '[OFF]'}
          </span>
          <p className="font-mono text-[12px] text-foreground break-all flex-1">
            {webhook.requestUrl}
          </p>
        </div>
        {webhook.description && (
          <p className="text-[12px] text-muted-foreground">{webhook.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-1">
          {webhook.eventTypes.map((e) => (
            <span
              key={e}
              className="font-mono text-[10px] text-muted-foreground border border-border px-1.5 py-0.5 rounded-sm"
            >
              {e}
            </span>
          ))}
        </div>
        <p className="font-mono text-[10px] tracking-wider text-muted-foreground">
          id · {webhook.id}
        </p>
      </header>

      <section className="px-4 py-3 border-b border-border">
        <p className="eyebrow mb-2">HEADERS</p>
        {webhook.headers && Object.keys(webhook.headers).length > 0 ? (
          <ul className="space-y-1">
            {Object.entries(webhook.headers).map(([k, v]) => (
              <li key={k} className="font-mono text-[11px]">
                <span className="text-muted-foreground">{k}</span>
                <span className="text-muted-foreground/60"> · </span>
                <span className="text-foreground break-all">
                  {/* Mask values whose key NAME suggests a credential.
                      Substring match (no anchors) covers the long tail:
                      `x-hub-signature`, `x-webhook-secret`,
                      `x-amz-security-token`, `cookie`, `x-shopify-hmac-sha256`,
                      etc. False positives (e.g. masking `event-key` when
                      harmless) are much cheaper than false negatives that
                      leak credentials into a debug surface. Last 4 chars
                      stay visible so the operator can still tell which
                      credential is configured. KEEP IN SYNC with the
                      runner/API redactSecretsForStorage heuristic. */}
                  {/auth|token|password|secret|cookie|signature|hmac|key$/i.test(k)
                    ? `••• ${v.slice(-4)}`
                    : v}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="font-mono text-[11px] text-muted-foreground">none configured</p>
        )}
      </section>

      <section>
        <p className="eyebrow px-4 pt-3 pb-2">DELIVERIES</p>
        {deliveries === undefined ? (
          <div className="px-4 py-6 grid place-items-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : deliveries.length === 0 ? (
          // Fallback: no deliveries yet, so we show the configured template
          // as a stand-in. This is the only case where the template (with
          // unresolved {{placeholders}}) is genuinely useful — once a real
          // delivery exists, its rendered body supersedes it for debugging.
          <NoDeliveriesFallback template={webhook.payloadTemplate} />
        ) : (
          <ul className="divide-y divide-border">
            {deliveries.map((d) => (
              <DeliveryRowExpanded key={d.id} delivery={d} />
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function NoDeliveriesFallback({ template }: { template?: string | null }) {
  const pretty = (() => {
    if (!template) return null;
    try {
      return JSON.stringify(JSON.parse(template), null, 2);
    } catch {
      // Templates contain `{{placeholders}}` which break JSON.parse —
      // show the raw form so the operator can read what's configured.
      return template;
    }
  })();
  return (
    <div className="px-4 pb-4 space-y-2">
      <p className="font-mono text-[11px] text-muted-foreground">no deliveries yet</p>
      <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
        configured payload template
      </p>
      {pretty ? (
        <pre className="font-mono text-[11px] text-foreground bg-secondary/40 border border-border rounded-sm p-3 overflow-auto max-h-64 whitespace-pre-wrap break-all">
          {pretty}
        </pre>
      ) : (
        <p className="font-mono text-[11px] text-muted-foreground">
          default — Apify-shape payload (resource, eventData, …)
        </p>
      )}
    </div>
  );
}

/**
 * Single delivery row showing what was sent and what came back. Both bodies
 * are pretty-printed when they parse as JSON — operators reading webhook
 * payloads expect indented form, and the receiver's response is often JSON
 * too. Fallback to raw on parse failure.
 */
function DeliveryRowExpanded({ delivery: d }: { delivery: WebhookDelivery }) {
  const prettyRequest = prettyJson(d.requestBody);
  const prettyResponse = prettyJson(d.responseBody);

  return (
    <li className="px-4 py-3 space-y-3">
      <div className="flex items-center gap-2 flex-wrap font-mono text-[11px]">
        <DeliveryBadge status={d.status} />
        <span className="text-foreground">{d.eventType}</span>
        {d.responseStatus !== null && (
          <span
            className={cn(
              'px-1.5 py-0.5 rounded-sm border',
              d.responseStatus >= 200 && d.responseStatus < 300
                ? 'border-signal/40 text-signal'
                : 'border-fail/40 text-fail'
            )}
          >
            HTTP {d.responseStatus}
          </span>
        )}
        <span className="text-muted-foreground">
          attempt {d.attemptCount}/{d.maxAttempts}
        </span>
        <span className="text-muted-foreground">{new Date(d.createdAt).toLocaleString()}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="eyebrow">REQUEST BODY · sent</p>
          {d.requestBody ? (
            <pre className="font-mono text-[11px] text-foreground bg-secondary/40 border border-border rounded-sm p-2 overflow-auto max-h-64 whitespace-pre-wrap break-all">
              {prettyRequest}
            </pre>
          ) : (
            // Null body means the delivery failed before render — usually
            // a template-rendering exception or the private-URL guard.
            // Explicit messaging beats a blank pre.
            <p className="font-mono text-[11px] text-muted-foreground">
              not recorded (delivery failed before render)
            </p>
          )}
        </div>
        <div className="space-y-1">
          <p className="eyebrow">RESPONSE BODY · received</p>
          {d.responseBody ? (
            <pre className="font-mono text-[11px] text-muted-foreground bg-secondary/40 border border-border rounded-sm p-2 overflow-auto max-h-64 whitespace-pre-wrap break-all">
              {prettyResponse}
            </pre>
          ) : (
            <p className="font-mono text-[11px] text-muted-foreground">no response body</p>
          )}
        </div>
      </div>
    </li>
  );
}

function prettyJson(s: string | null | undefined): string {
  if (!s) return '';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function DeliveryBadge({ status }: { status: string }) {
  const cls =
    status === 'DELIVERED'
      ? 'border-signal/40 text-signal'
      : status === 'FAILED'
        ? 'border-fail/40 text-fail'
        : 'border-border text-muted-foreground';
  return (
    <span
      className={cn('font-mono text-[10px] tracking-wider border px-1.5 py-0.5 rounded-sm', cls)}
    >
      {status}
    </span>
  );
}

export default function RunDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center min-h-[60vh]">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <RunDetail />
    </Suspense>
  );
}
