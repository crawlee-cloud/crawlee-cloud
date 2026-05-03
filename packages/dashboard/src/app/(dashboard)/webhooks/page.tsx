'use client';

import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Save,
  Send,
  Trash2,
  Webhook as WebhookIcon,
} from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { Pagination } from '@/components/pagination';
import {
  createWebhook,
  deleteWebhook,
  getActors,
  getWebhookDeliveries,
  getWebhooks,
  testWebhook,
  updateWebhook,
  type Actor,
  type Webhook,
  type WebhookDelivery,
} from '@/lib/api';
import { FETCH_ALL_LIMIT, PAGE_SIZE } from '@/lib/constants';
import { usePageParam } from '@/lib/use-page-param';
import { WEBHOOK_EVENTS } from '@/lib/webhooks';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';

export default function WebhooksPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { offset, setOffset } = usePageParam();
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [total, setTotal] = useState(0);
  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  // Edit mode: editingId is the webhook id being edited. The form is shown
  // either when showForm (create) or editingId (edit) is set; never both.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Per-row debug state. Drawer is opt-in (lazy-load deliveries when expanded)
  // so the list view stays cheap even with many webhooks. Test/loading flags
  // live on the row so multiple webhooks can be exercised independently.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveriesByWebhook, setDeliveriesByWebhook] = useState<Record<string, WebhookDelivery[]>>(
    {}
  );
  const [loadingDeliveriesId, setLoadingDeliveriesId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      getWebhooks({ offset, limit: PAGE_SIZE }).catch(() => null),
      getActors({ limit: FETCH_ALL_LIMIT }).catch(() => null),
    ]).then(([w, a]) => {
      if (!alive) return;
      if (w) {
        setWebhooks(w.items);
        setTotal(w.total);
      }
      if (a) setActors(a.items);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [offset]);

  function handleSaved(w: Webhook) {
    if (editingId) {
      // Replace in place so the row keeps its position in the list.
      setWebhooks((prev) => prev.map((x) => (x.id === w.id ? w : x)));
      setEditingId(null);
      toast.success('Webhook updated', { description: w.requestUrl });
    } else {
      setWebhooks((prev) => [w, ...prev]);
      setShowForm(false);
      toast.success('Webhook created', { description: w.requestUrl });
    }
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

  async function loadDeliveries(id: string) {
    setLoadingDeliveriesId(id);
    try {
      const items = await getWebhookDeliveries(id);
      setDeliveriesByWebhook((prev) => ({ ...prev, [id]: items }));
    } catch (err) {
      toast.error('Failed to load deliveries', { description: (err as Error).message });
    } finally {
      setLoadingDeliveriesId(null);
    }
  }

  async function handleToggleDrawer(w: Webhook) {
    if (expandedId === w.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(w.id);
    if (!deliveriesByWebhook[w.id]) {
      await loadDeliveries(w.id);
    }
  }

  async function handleTest(w: Webhook) {
    setTestingId(w.id);
    try {
      // Multi-event webhooks: fire one delivery per subscribed event in
      // parallel. Receivers often branch by event (SUCCEEDED → queue,
      // FAILED → Slack), so testing only the first event hides bugs in the
      // other branches. allSettled instead of all so a single network
      // failure doesn't drop the rest of the results.
      const events = w.eventTypes.length > 0 ? w.eventTypes : [undefined];
      const settled = await Promise.allSettled(events.map((evt) => testWebhook(w.id, evt)));

      const deliveries: WebhookDelivery[] = [];
      const errors: string[] = [];
      let delivered = 0;
      let failed = 0;
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          deliveries.push(r.value);
          if (r.value.status === 'DELIVERED') delivered++;
          else failed++;
        } else {
          errors.push((r.reason as Error).message);
          failed++;
        }
      }

      // Newest-first into the cached list so the drawer reflects every
      // attempt without a refetch round trip.
      if (deliveries.length > 0) {
        setDeliveriesByWebhook((prev) => ({
          ...prev,
          [w.id]: [...deliveries.slice().reverse(), ...(prev[w.id] ?? [])],
        }));
      }
      // Auto-expand on test so the user sees the result immediately.
      setExpandedId(w.id);

      const total = events.length;
      if (failed === 0) {
        toast.success(
          total === 1 ? 'Test delivered' : `${String(total)} of ${String(total)} delivered`,
          {
            description:
              total === 1
                ? `${String(deliveries[0]?.responseStatus ?? '???')} from ${w.requestUrl}`
                : w.requestUrl,
          }
        );
      } else if (delivered === 0) {
        toast.error(total === 1 ? 'Test failed' : `${String(failed)} of ${String(total)} failed`, {
          description: errors[0] ?? deliveries[0]?.responseBody?.slice(0, 200) ?? 'no response',
        });
      } else {
        // Mixed outcome — surface the count clearly so the operator opens
        // the drawer to see which event broke.
        toast.error(`${String(delivered)} delivered · ${String(failed)} failed`, {
          description: 'Open the log to see per-event results',
        });
      }
    } catch (err) {
      toast.error('Test failed', { description: (err as Error).message });
    } finally {
      setTestingId(null);
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
          onClick={() => {
            // Opening "new" cancels any in-progress edit so we don't show
            // two forms simultaneously.
            setEditingId(null);
            setShowForm((v) => !v);
          }}
          className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm"
        >
          <Plus className="h-3.5 w-3.5" /> new webhook
        </button>
      </div>

      {showForm && !editingId && (
        <CreateForm actors={actors} onSaved={handleSaved} onCancel={() => setShowForm(false)} />
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
            const expanded = expandedId === w.id;
            const cachedDeliveries = deliveriesByWebhook[w.id];
            const lastDelivery = cachedDeliveries?.[0];
            return (
              <li key={w.id} className="panel">
                <div className="p-4 flex items-start gap-4">
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
                      <LastSeen delivery={lastDelivery} loaded={cachedDeliveries !== undefined} />
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleTest(w)}
                      disabled={testingId === w.id}
                      title="Fire a synthetic test event (no retries, 10s timeout)"
                      className="h-7 px-2 inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider border border-border rounded-sm text-muted-foreground hover:text-foreground hover:border-signal/40 disabled:opacity-50"
                    >
                      {testingId === w.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="h-3 w-3" />
                      )}
                      test
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleDrawer(w)}
                      title={expanded ? 'Hide deliveries' : 'Show recent deliveries'}
                      className="h-7 px-2 inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider border border-border rounded-sm text-muted-foreground hover:text-foreground hover:border-signal/40"
                    >
                      {expanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                      log
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // Toggle: clicking edit on the already-being-edited
                        // row collapses the form. Also closes the create form.
                        setShowForm(false);
                        setEditingId((cur) => (cur === w.id ? null : w.id));
                      }}
                      title="Edit webhook"
                      className={cn(
                        'h-7 w-7 grid place-items-center border rounded-sm transition-colors',
                        editingId === w.id
                          ? 'border-signal/50 text-signal bg-signal/5'
                          : 'border-border text-muted-foreground hover:text-foreground hover:border-signal/40'
                      )}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(w.id)}
                      className="text-muted-foreground hover:text-fail p-1"
                      title="Delete webhook"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {editingId === w.id && (
                  <div className="border-t border-border">
                    <CreateForm
                      actors={actors}
                      initial={w}
                      onSaved={handleSaved}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                )}

                {expanded && (
                  <DeliveriesDrawer
                    deliveries={cachedDeliveries}
                    loading={loadingDeliveriesId === w.id}
                    onRefresh={() => void loadDeliveries(w.id)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Pagination total={total} offset={offset} limit={PAGE_SIZE} onChange={setOffset} />
    </div>
  );
}

/**
 * Same form, two modes: create (no `initial`) or edit (initial=existing
 * webhook). When editing, the form pre-populates from the webhook and calls
 * updateWebhook on save. Keeping a single component avoids drifting fields
 * between create and edit, which is the usual reason these get out of sync.
 */
function CreateForm({
  actors,
  initial,
  onSaved,
  onCancel,
}: {
  actors: Actor[];
  initial?: Webhook;
  onSaved: (w: Webhook) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const isEdit = !!initial;
  const [requestUrl, setRequestUrl] = useState(initial?.requestUrl ?? 'https://');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [actorId, setActorId] = useState<string>(initial?.actorId ?? '');
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initial?.eventTypes ?? ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED'])
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

  async function handleSave() {
    if (selected.size === 0) {
      setError('select at least one event');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        requestUrl,
        // Preserve "(no description)" vs "" intent — server treats empty
        // string and null differently in some payload templates. Send
        // undefined so the field is omitted from the patch when blank.
        description: description || undefined,
        // actorId='' means "global" → send undefined to clear in edit mode.
        actorId: actorId || undefined,
        eventTypes: Array.from(selected),
      };
      const saved = isEdit
        ? await updateWebhook(initial.id, payload)
        : await createWebhook(payload);
      onSaved(saved);
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error(isEdit ? 'Failed to update webhook' : 'Failed to create webhook', {
        description: msg,
      });
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
          onClick={() => void handleSave()}
          disabled={submitting}
          className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background rounded-sm disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {isEdit ? 'save changes' : 'create'}
        </button>
      </div>
    </section>
  );
}

/**
 * Compact "last delivery" indicator on the right of each webhook row.
 * Three states:
 *   - not loaded yet (drawer never opened): muted "—"
 *   - loaded, never delivered: muted "no deliveries"
 *   - loaded with at least one delivery: colored dot + last status
 */
function LastSeen({
  delivery,
  loaded,
}: {
  delivery: WebhookDelivery | undefined;
  loaded: boolean;
}) {
  if (!loaded) return <span>last · —</span>;
  if (!delivery) return <span>last · no deliveries</span>;

  const isOk = delivery.status === 'DELIVERED';
  const isFailed = delivery.status === 'FAILED';
  return (
    <span className="inline-flex items-center gap-1">
      last ·
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          isOk ? 'bg-signal' : isFailed ? 'bg-fail' : 'bg-muted-foreground'
        )}
      />
      <span className={cn(isOk ? 'text-signal' : isFailed ? 'text-fail' : '')}>
        {delivery.status.toLowerCase()}
        {delivery.responseStatus !== null && ` · ${String(delivery.responseStatus)}`}
      </span>
      <span>· {timeAgo(delivery.createdAt)}</span>
    </span>
  );
}

/**
 * Expandable panel showing the last N delivery attempts for one webhook.
 * Each row shows: status dot, event type, HTTP code, attempt count, age,
 * truncated response/error body.
 */
function DeliveriesDrawer({
  deliveries,
  loading,
  onRefresh,
}: {
  deliveries: WebhookDelivery[] | undefined;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (loading || !deliveries) {
    return (
      <div className="border-t border-border px-5 py-4 grid place-items-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (deliveries.length === 0) {
    return (
      <div className="border-t border-border px-5 py-4 grid-bg text-center">
        <p className="font-mono text-[10px] tracking-widest text-muted-foreground">
          [ NO DELIVERIES YET ]
        </p>
        <p className="text-[12px] text-muted-foreground mt-1">
          Fire a test event with the button above, or wait for a real run to match.
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-border">
      <div className="px-5 py-2 flex items-center justify-between bg-secondary/30">
        <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
          last {deliveries.length} {deliveries.length === 1 ? 'delivery' : 'deliveries'}
        </p>
        <button
          type="button"
          onClick={onRefresh}
          className="font-mono text-[10px] tracking-wider text-muted-foreground hover:text-foreground"
        >
          refresh
        </button>
      </div>
      <ul className="divide-y divide-border">
        {deliveries.map((d) => (
          <li key={d.id} className="px-5 py-3 text-[12px] flex items-start gap-3">
            <DeliveryStatusBadge status={d.status} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap font-mono text-[11px]">
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
                <span className="text-muted-foreground">{timeAgo(d.createdAt)}</span>
              </div>
              {d.responseBody && (
                <pre className="mt-1 text-[11px] text-muted-foreground font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                  {d.responseBody}
                </pre>
              )}
              {d.nextRetryAt && d.status === 'PENDING' && (
                <p className="mt-1 font-mono text-[10px] text-muted-foreground tracking-wider">
                  next retry · {new Date(d.nextRetryAt).toLocaleString()}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeliveryStatusBadge({ status }: { status: string }) {
  const map: Record<string, { icon: typeof CheckCircle2; className: string }> = {
    DELIVERED: { icon: CheckCircle2, className: 'text-signal' },
    FAILED: { icon: AlertCircle, className: 'text-fail' },
    PENDING: { icon: Loader2, className: 'text-muted-foreground animate-spin' },
  };
  const entry = map[status] ?? { icon: AlertCircle, className: 'text-muted-foreground' };
  const Icon = entry.icon;
  return <Icon className={cn('h-3.5 w-3.5 shrink-0 mt-0.5', entry.className)} />;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
