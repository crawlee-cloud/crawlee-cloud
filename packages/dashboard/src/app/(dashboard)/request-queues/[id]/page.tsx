'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ListOrdered, Loader2, Trash2 } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { prefixPath } from '@/lib/path-prefix';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import {
  deleteRequestQueue,
  findProducingRun,
  getActor,
  getRequestQueue,
  type Actor,
  type RequestQueue,
  type Run,
} from '@/lib/api';
import { cn } from '@/lib/utils';

export default function RequestQueueDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();

  const [queue, setQueue] = useState<RequestQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [producingRun, setProducingRun] = useState<Run | null>(null);
  const [producingActor, setProducingActor] = useState<Actor | null>(null);

  useEffect(() => {
    let alive = true;
    getRequestQueue(id)
      .then((q) => alive && setQueue(q))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (!queue) return;
    let alive = true;
    findProducingRun('queue', queue.id)
      .then(async (r) => {
        if (!alive || !r) return;
        setProducingRun(r);
        const a = await getActor(r.actId).catch(() => null);
        if (alive) setProducingActor(a);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [queue]);

  async function handleDelete() {
    const ok = await confirm({
      tone: 'danger',
      title: 'Delete this queue?',
      description: 'All pending and handled requests are removed permanently.',
      confirmLabel: 'delete queue',
    });
    if (!ok) return;
    try {
      await deleteRequestQueue(id);
      toast.success('Queue deleted');
      router.push(prefixPath('/request-queues'));
    } catch (err) {
      toast.error('Failed to delete queue', { description: (err as Error).message });
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center min-h-[40vh]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!queue) {
    return (
      <div className="grid place-items-center min-h-[40vh] text-center">
        <div>
          <p className="font-mono text-[11px] tracking-widest text-muted-foreground mb-2">
            [ QUEUE NOT FOUND ]
          </p>
          <AppLink href="/request-queues" className="text-[13px] hover:text-signal">
            ← back to queues
          </AppLink>
        </div>
      </div>
    );
  }

  const progress =
    queue.totalRequestCount > 0
      ? Math.round((queue.handledRequestCount / queue.totalRequestCount) * 100)
      : 0;

  return (
    <div className="space-y-6 max-w-5xl">
      <AppLink
        href="/request-queues"
        className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-muted-foreground hover:text-foreground uppercase"
      >
        <ArrowLeft className="h-3 w-3" /> request queues
      </AppLink>

      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 pb-5 border-b border-border">
        <div className="space-y-2 min-w-0">
          <p className="eyebrow">QUEUE · {queue.id.slice(0, 12)}</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight truncate">
            {queue.name || 'Unnamed queue'}
          </h1>
          <p className="font-mono text-[11px] text-muted-foreground">{queue.id}</p>
        </div>
        <button
          type="button"
          onClick={() => void handleDelete()}
          className="h-8 px-3 self-start md:self-auto inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border text-muted-foreground hover:border-fail/40 hover:text-fail rounded-sm"
        >
          <Trash2 className="h-3.5 w-3.5" /> delete
        </button>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border rounded-md overflow-hidden">
        <Tile label="Total">{queue.totalRequestCount.toLocaleString()}</Tile>
        <Tile
          label="Pending"
          tone={queue.pendingRequestCount > 0 ? 'signal' : undefined}
          live={queue.pendingRequestCount > 0}
        >
          {queue.pendingRequestCount.toLocaleString()}
        </Tile>
        <Tile label="Handled">{queue.handledRequestCount.toLocaleString()}</Tile>
        <Tile label="Multi-client" tone={queue.hadMultipleClients ? 'warn' : undefined}>
          {queue.hadMultipleClients ? 'YES' : 'NO'}
        </Tile>
      </div>

      {/* Progress bar */}
      <section className="panel p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="eyebrow">PROGRESS · HANDLED / TOTAL</p>
          <span className="font-mono text-[12px] text-foreground tnum">{progress}%</span>
        </div>
        <div className="h-2 w-full bg-secondary border border-border rounded-sm overflow-hidden">
          <div style={{ width: `${progress}%` }} className="h-full bg-signal transition-all" />
        </div>
        <p className="font-mono text-[10px] tracking-widest text-muted-foreground">
          {queue.handledRequestCount.toLocaleString()} handled ·{' '}
          {queue.pendingRequestCount.toLocaleString()} pending
        </p>
      </section>

      {/* Producer backlink */}
      {producingRun && (
        <section className="panel p-5 space-y-3">
          <p className="eyebrow">PRODUCED · BY</p>
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <AppLink
              href={`/runs/${producingRun.id}`}
              className="font-mono text-foreground hover:text-signal"
            >
              run · {producingRun.id.slice(0, 12)}
            </AppLink>
            <span className="text-muted-foreground">/</span>
            {producingActor ? (
              <AppLink
                href={`/actors/${producingActor.name}`}
                className="text-foreground hover:text-signal"
              >
                {producingActor.title || producingActor.name}
              </AppLink>
            ) : (
              <span className="font-mono text-muted-foreground text-[12px]">
                actor · {producingRun.actId.slice(0, 12)}
              </span>
            )}
          </div>
        </section>
      )}

      {/* Meta */}
      <section className="panel p-5 space-y-4">
        <p className="eyebrow">META</p>
        <DefRow label="Created">{new Date(queue.createdAt).toLocaleString()}</DefRow>
        <DefRow label="Modified">{new Date(queue.modifiedAt).toLocaleString()}</DefRow>
        <DefRow label="Last accessed">{new Date(queue.accessedAt).toLocaleString()}</DefRow>
      </section>

      {queue.totalRequestCount === 0 && (
        <div className="panel grid-bg p-12 text-center">
          <ListOrdered className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
          <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
            [ NO REQUESTS · YET ]
          </p>
          <p className="text-[13px] text-muted-foreground mt-2">
            Requests appear here once an actor calls{' '}
            <code className="font-mono text-foreground">queue.addRequest()</code>.
          </p>
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
  tone?: 'signal' | 'warn';
  live?: boolean;
}) {
  const toneClass =
    tone === 'signal' ? 'text-signal' : tone === 'warn' ? 'text-warn' : 'text-foreground';
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

function DefRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="eyebrow mb-1">{label}</p>
      <p className="text-[13px] text-foreground">{children}</p>
    </div>
  );
}
