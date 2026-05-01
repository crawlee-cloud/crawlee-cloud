'use client';

import { useEffect, useState } from 'react';
import { Loader2, Plus, Save, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import {
  createWebhook,
  deleteWebhook,
  getActors,
  getWebhooks,
  updateWebhook,
  type Actor,
  type Webhook,
} from '@/lib/api';
import { WEBHOOK_EVENTS } from '@/lib/webhooks';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';

export default function WebhooksPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([getWebhooks().catch(() => []), getActors().catch(() => [])]).then(
      ([w, a]) => {
        if (!alive) return;
        setWebhooks(w);
        setActors(a);
        setLoading(false);
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  function handleCreated(w: Webhook) {
    setWebhooks((prev) => [w, ...prev]);
    setShowForm(false);
    toast.success('Webhook created', { description: w.requestUrl });
  }

  async function handleToggle(w: Webhook) {
    try {
      const updated = await updateWebhook(w.id, { isEnabled: !w.isEnabled });
      setWebhooks((prev) => prev.map((x) => (x.id === w.id ? updated : x)));
      toast.success(updated.isEnabled ? 'Webhook enabled' : 'Webhook disabled');
    } catch (err) {
      toast.error('Failed to update webhook', { description: (err as Error).message });
    }
  }

  async function handleDelete(id: string) {
    const ok = await confirm({
      tone: 'danger',
      title: 'Delete webhook?',
      description: 'Future events matching this subscription will no longer be delivered.',
      confirmLabel: 'delete webhook',
    });
    if (!ok) return;
    try {
      await deleteWebhook(id);
      setWebhooks((prev) => prev.filter((w) => w.id !== id));
      toast.success('Webhook deleted');
    } catch (err) {
      toast.error('Failed to delete webhook', { description: (err as Error).message });
    }
  }

  const actorById = new Map(actors.map((a) => [a.id, a]));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6 pb-4 border-b border-border">
        <div>
          <p className="eyebrow mb-2">INTEGRATE · DELIVERY</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Webhooks</h1>
          <p className="text-muted-foreground mt-2 text-[13px]">
            Forward run lifecycle events to your services.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm"
        >
          <Plus className="h-3.5 w-3.5" /> new webhook
        </button>
      </div>

      {showForm && (
        <CreateForm actors={actors} onCreated={handleCreated} onCancel={() => setShowForm(false)} />
      )}

      {loading ? (
        <div className="grid place-items-center py-24">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : webhooks.length === 0 ? (
        <div className="panel grid-bg p-16 text-center">
          <WebhookIcon className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
          <p className="font-mono text-[11px] tracking-wider text-muted-foreground">
            [ NO WEBHOOKS CONFIGURED ]
          </p>
          <p className="text-[13px] text-muted-foreground mt-2">
            Create one to get notified when runs succeed, fail, or time out.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {webhooks.map((w) => {
            const actor = w.actorId ? actorById.get(w.actorId) : null;
            return (
              <li key={w.id} className="panel p-4 flex items-start gap-4">
                <button
                  type="button"
                  onClick={() => void handleToggle(w)}
                  title={w.isEnabled ? 'Disable' : 'Enable'}
                  className={cn(
                    'mt-1 shrink-0 font-mono text-[10px] tracking-widest px-1.5 py-0.5 rounded-sm border transition-colors',
                    w.isEnabled
                      ? 'text-signal border-signal/40 hover:bg-signal/10'
                      : 'text-muted-foreground border-border hover:text-foreground'
                  )}
                >
                  {w.isEnabled ? '[LIVE]' : '[OFF]'}
                </button>

                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[13px] text-foreground truncate">{w.requestUrl}</p>
                  {w.description && (
                    <p className="text-[12px] text-muted-foreground mt-1">{w.description}</p>
                  )}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {w.eventTypes.map((e) => (
                      <span
                        key={e}
                        className="font-mono text-[10px] text-muted-foreground border border-border px-1.5 py-0.5 rounded-sm"
                      >
                        {e}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 mt-2 font-mono text-[10px] text-muted-foreground tracking-wider">
                    <span>id · {w.id.slice(0, 12)}</span>
                    {actor ? (
                      <AppLink href={`/actors/${actor.name}`} className="hover:text-foreground">
                        scope · {actor.name}
                      </AppLink>
                    ) : (
                      <span>scope · global</span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleDelete(w.id)}
                  className="text-muted-foreground hover:text-fail p-1"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CreateForm({
  actors,
  onCreated,
  onCancel,
}: {
  actors: Actor[];
  onCreated: (w: Webhook) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [requestUrl, setRequestUrl] = useState('https://');
  const [description, setDescription] = useState('');
  const [actorId, setActorId] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(
    new Set(['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED'])
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate() {
    if (selected.size === 0) {
      setError('select at least one event');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createWebhook({
        requestUrl,
        description: description || undefined,
        actorId: actorId || undefined,
        eventTypes: Array.from(selected),
      });
      onCreated(created);
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error('Failed to create webhook', { description: msg });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel p-5 space-y-4 bg-secondary/30">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 space-y-1.5">
          <label className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
            Request URL
          </label>
          <input
            value={requestUrl}
            onChange={(e) => setRequestUrl(e.target.value)}
            className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
          />
        </div>
        <div className="space-y-1.5">
          <label className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
            Scope
          </label>
          <select
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            className="w-full h-9 px-2 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
          >
            <option value="">all actors · global</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
          Description · optional
        </label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Posts to #scrapers in Slack"
          className="w-full h-9 px-3 rounded-sm border border-border bg-background text-[12px] text-foreground focus:outline-none focus:border-signal/50"
        />
      </div>

      <div className="space-y-2">
        <label className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
          Events
        </label>
        {WEBHOOK_EVENTS.map((g) => (
          <div key={g.id} className="space-y-2">
            <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
              {g.label}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
              {g.events.map((e) => {
                const isOn = selected.has(e.id);
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => toggle(e.id)}
                    className={cn(
                      'text-left px-3 py-2 border rounded-sm transition-colors',
                      isOn ? 'border-signal/50 bg-signal/5' : 'border-border bg-background'
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] text-foreground">{e.id}</span>
                      <span
                        className={cn(
                          'font-mono text-[10px]',
                          isOn ? 'text-signal' : 'text-muted-foreground/50'
                        )}
                      >
                        {isOn ? '[ON]' : '[ ]'}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">{e.blurb}</p>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {error && <p className="font-mono text-[11px] text-fail">[ERR] {error}</p>}

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 px-3 text-[12px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={submitting}
          className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background rounded-sm disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          create
        </button>
      </div>
    </section>
  );
}
