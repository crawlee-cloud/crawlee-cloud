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
} from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { StatusChip } from '@/components/ui/badge';
import {
  abortRun,
  downloadAsBlob,
  getActor,
  getRun,
  getRunDatasetItems,
  getRunInput,
  getRunLogs,
  openInTabAsBlob,
  type Actor,
  type Run,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';

type Tab = 'logs' | 'input' | 'output';

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
        const [r, l] = await Promise.all([getRun(id), getRunLogs(id, { limit: 500, tail: true })]);
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

  // Resolve the actor lazily once we know which one this run targeted.
  useEffect(() => {
    if (!run) return;
    let alive = true;
    getActor(run.actId)
      .then((a) => alive && setActor(a))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [run]);

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
      getRunDatasetItems(id, { limit: 200 })
        .then((d) => setDataset(d || []))
        .catch(() => setDataset([]))
        .finally(() => setDatasetLoading(false));
    }
  }, [tab, id, input, inputLoading, dataset, datasetLoading]);

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
          <p className="eyebrow">RUN · {run.id.slice(0, 12)}</p>
          <div className="flex items-center gap-3">
            <h1 className="text-[28px] leading-none font-medium tracking-tight">Execution</h1>
            <StatusChip status={run.status} />
          </div>
          <p className="font-mono text-[11px] text-muted-foreground">
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
            <DefRow icon={Database} label="Dataset">
              <AppLink
                href={`/datasets/${run.defaultDatasetId}`}
                className="font-mono text-[11px] text-foreground hover:text-signal break-all"
              >
                {run.defaultDatasetId}
              </AppLink>
            </DefRow>
          )}
          {run.defaultKeyValueStoreId && (
            <DefRow icon={Boxes} label="KV store">
              <AppLink
                href={`/key-value-stores/${run.defaultKeyValueStoreId}`}
                className="font-mono text-[11px] text-foreground hover:text-signal break-all"
              >
                {run.defaultKeyValueStoreId}
              </AppLink>
            </DefRow>
          )}
          {run.defaultRequestQueueId && (
            <DefRow icon={ListOrdered} label="Request queue">
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
                  <pre className="font-mono text-[12px] text-foreground whitespace-pre-wrap p-4 border border-border rounded-sm bg-background/60">
                    {JSON.stringify(input, null, 2)}
                  </pre>
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
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="eyebrow flex items-center gap-1.5 mb-1">
        <Icon className="h-3 w-3" /> {label}
      </p>
      <p className="text-[12px] text-foreground">{children}</p>
    </div>
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
