'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Play,
  Trash2,
  Loader2,
  Database,
  Hammer,
  Webhook as WebhookIcon,
  Settings as SettingsIcon,
  GitCommit,
  GitBranch,
  History,
  Save,
  Plus,
  X,
  CircleDot,
  Globe,
  CheckCircle2,
} from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { CopyButton } from '@/components/ui/copy-button';
import { prefixPath } from '@/lib/path-prefix';
import { Badge, StatusChip } from '@/components/ui/badge';
import {
  abortBuild,
  createWebhook,
  deleteActor,
  deleteWebhook,
  getActor,
  getActorRuns,
  getBuilds,
  getWebhooks,
  startBuild,
  startRun,
  updateActor,
  type Actor,
  type ActorBuild,
  type Run,
  type Webhook,
} from '@/lib/api';
import { FETCH_ALL_LIMIT } from '@/lib/constants';
import { WEBHOOK_EVENTS } from '@/lib/webhooks';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';

type Tab = 'overview' | 'config' | 'builds' | 'webhooks' | 'runs';

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: 'Overview', icon: CircleDot },
  { id: 'config', label: 'Config', icon: SettingsIcon },
  { id: 'builds', label: 'Builds', icon: Hammer },
  { id: 'webhooks', label: 'Webhooks', icon: WebhookIcon },
  { id: 'runs', label: 'Runs', icon: History },
];

export default function ActorDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();

  const [actor, setActor] = useState<Actor | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [builds, setBuilds] = useState<ActorBuild[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  // Per-run webhooks across runs of this actor — separate state from
  // catalog `webhooks` so the sub-section can show its own count and
  // empty state without conflating with the configured-hook list.
  const [runWebhooks, setRunWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      try {
        const a = await getActor(name);
        if (!alive) return;
        setActor(a);
        // Fan-out the secondary fetches; let any individual one fail without blocking the page.
        const [r, b, w, rw] = await Promise.all([
          getActorRuns(a.id).catch(() => []),
          getBuilds(a.id).catch(() => []),
          getWebhooks({ limit: FETCH_ALL_LIMIT })
            .then((p) => p.items)
            .catch(() => [] as Webhook[]),
          // Per-run hooks for runs of this actor. Server-side filter via
          // runActorId — much cheaper than pulling all per-run hooks and
          // filtering client-side. When runActorId is set the API
          // defaults scope to 'all', but we pass scope=run explicitly so
          // the intent is clear from the call site.
          getWebhooks({ scope: 'run', runActorId: a.id, limit: FETCH_ALL_LIMIT })
            .then((p) => p.items)
            .catch(() => [] as Webhook[]),
        ]);
        if (!alive) return;
        setRuns(r);
        setBuilds(b);
        setWebhooks(w.filter((wh) => !wh.actorId || wh.actorId === a.id));
        setRunWebhooks(rw);
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [name]);

  async function handleDelete() {
    if (!actor) return;
    const ok = await confirm({
      tone: 'danger',
      title: `Delete actor "${actor.name}"?`,
      description: (
        <>
          Removes the actor record, default storage, and all build history. Run logs and datasets
          are kept.
          <br />
          <span className="text-foreground font-mono">This cannot be undone.</span>
        </>
      ),
      confirmLabel: 'delete actor',
    });
    if (!ok) return;
    try {
      await deleteActor(actor.id);
      toast.success(`Actor "${actor.name}" deleted`);
      router.push(prefixPath('/actors'));
    } catch (err) {
      toast.error('Failed to delete actor', { description: (err as Error).message });
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center min-h-[60vh]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!actor) {
    return (
      <div className="grid place-items-center min-h-[60vh] text-center">
        <div>
          <p className="font-mono text-[11px] tracking-widest text-muted-foreground mb-2">
            [ ACTOR NOT FOUND ]
          </p>
          <AppLink href="/actors" className="text-[13px] text-foreground hover:text-signal">
            ← back to actors
          </AppLink>
        </div>
      </div>
    );
  }

  const lastBuild = builds[0];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="space-y-4">
        <AppLink
          href="/actors"
          className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
        >
          <ArrowLeft className="h-3 w-3" /> actors
        </AppLink>

        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 pb-5 border-b border-border">
          <div className="space-y-2 min-w-0">
            <p className="eyebrow inline-flex items-center gap-1.5">
              ACTOR · {actor.id.slice(0, 12)}
              <CopyButton value={actor.id} label="Actor ID" />
            </p>
            <h1 className="text-[28px] leading-none font-medium tracking-tight truncate">
              {actor.title || actor.name}
            </h1>
            <p className="font-mono text-[12px] text-muted-foreground">
              <span className="text-signal">@crawlee/</span>
              {actor.name}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleDelete()}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border text-muted-foreground hover:border-fail/40 hover:text-fail rounded-sm transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
            <button
              type="button"
              onClick={() => setTab('overview')}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm"
            >
              <Play className="h-3.5 w-3.5" /> Run
            </button>
          </div>
        </div>

        {/* Build summary strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border rounded-md overflow-hidden">
          <SummaryTile label="Total runs" value={runs.length} />
          <SummaryTile
            label="Last run"
            value={runs[0] ? <StatusChip status={runs[0].status} /> : '—'}
          />
          <SummaryTile
            label="Last build"
            value={lastBuild ? <StatusChip status={lastBuild.status} /> : '—'}
          />
          <SummaryTile
            label="Image"
            value={
              actor.defaultRunOptions?.image ? (
                <span className="font-mono text-[11px] text-muted-foreground truncate block">
                  {actor.defaultRunOptions.image}
                </span>
              ) : (
                '—'
              )
            }
          />
        </div>
      </div>

      {/* Tabs */}
      <nav className="flex border-b border-border">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-2 px-4 h-10 text-[12px] font-mono uppercase tracking-wider transition-colors -mb-px border-b',
                isActive
                  ? 'text-signal border-signal'
                  : 'text-muted-foreground border-transparent hover:text-foreground'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* Tab panels */}
      <div>
        {tab === 'overview' && (
          <OverviewPanel
            actor={actor}
            onStarted={(run) => router.push(prefixPath(`/runs/${run.id}`))}
          />
        )}
        {tab === 'config' && <ConfigPanel actor={actor} onSaved={(updated) => setActor(updated)} />}
        {tab === 'builds' && <BuildsPanel actor={actor} builds={builds} setBuilds={setBuilds} />}
        {tab === 'webhooks' && (
          <WebhooksPanel
            actor={actor}
            webhooks={webhooks}
            setWebhooks={setWebhooks}
            runWebhooks={runWebhooks}
          />
        )}
        {tab === 'runs' && <RunsPanel runs={runs} />}
      </div>
    </div>
  );
}

// ===========================================================================
// SUMMARY TILE
// ===========================================================================

function SummaryTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-card px-5 py-4 min-w-0">
      <p className="eyebrow mb-2">{label}</p>
      <div className="text-foreground text-base leading-tight tnum truncate">{value}</div>
    </div>
  );
}

// ===========================================================================
// OVERVIEW + RUN LAUNCHER
// ===========================================================================

function OverviewPanel({ actor, onStarted }: { actor: Actor; onStarted: (run: Run) => void }) {
  const [inputJson, setInputJson] = useState('{\n  \n}');
  const [timeout, setTimeoutSecs] = useState(actor.defaultRunOptions?.timeoutSecs ?? 3600);
  const [memory, setMemory] = useState(actor.defaultRunOptions?.memoryMbytes ?? 1024);
  const [starting, setStarting] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    let parsed: unknown;
    try {
      parsed = inputJson.trim() ? JSON.parse(inputJson) : undefined;
      setJsonError(null);
    } catch {
      setJsonError('input is not valid JSON');
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const run = await startRun(actor.id, { input: parsed, timeout, memory });
      onStarted(run);
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Run launcher */}
      <section className="panel p-6 lg:col-span-2 space-y-5">
        <header className="flex items-center justify-between">
          <div>
            <p className="eyebrow">EXEC · LAUNCH</p>
            <h2 className="text-base mt-1">Start a new run</h2>
          </div>
        </header>

        <div className="space-y-2">
          <Label>input · JSON</Label>
          <textarea
            value={inputJson}
            onChange={(e) => {
              setInputJson(e.target.value);
              setJsonError(null);
            }}
            spellCheck={false}
            className={cn(
              'w-full h-44 px-3 py-2 rounded-sm border bg-background font-mono text-[12px] text-foreground resize-none focus:outline-none transition-colors',
              jsonError ? 'border-fail/60' : 'border-border focus:border-signal/50'
            )}
            placeholder='{ "url": "https://example.com" }'
          />
          {jsonError && <p className="font-mono text-[11px] text-fail">[ERR] {jsonError}</p>}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Timeout · seconds">
            <select
              value={timeout}
              onChange={(e) => setTimeoutSecs(Number(e.target.value))}
              className="w-full h-9 px-2 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
            >
              {[300, 600, 1800, 3600, 7200, 14400].map((n) => (
                <option key={n} value={n}>
                  {n}s · {fmtDuration(n)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Memory · MB">
            <select
              value={memory}
              onChange={(e) => setMemory(Number(e.target.value))}
              className="w-full h-9 px-2 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
            >
              {[256, 512, 1024, 2048, 4096, 8192].map((n) => (
                <option key={n} value={n}>
                  {n} MB
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error && (
          <p className="font-mono text-[11px] text-fail border border-fail/30 bg-fail/5 p-2 rounded-sm">
            [ERR] {error}
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={starting}
            className="h-9 px-4 inline-flex items-center gap-2 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50"
          >
            {starting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Execute
          </button>
        </div>
      </section>

      {/* Description / metadata */}
      <section className="panel p-6 space-y-4">
        <p className="eyebrow">META</p>
        <DefRow label="ID" mono>
          {actor.id}
        </DefRow>
        <DefRow label="Created">{new Date(actor.createdAt).toLocaleString()}</DefRow>
        <DefRow label="Modified">{new Date(actor.modifiedAt).toLocaleString()}</DefRow>
        {actor.description && (
          <div>
            <p className="eyebrow mb-2">ABOUT</p>
            <p className="text-[13px] text-foreground leading-relaxed">{actor.description}</p>
          </div>
        )}
      </section>
    </div>
  );
}

// ===========================================================================
// CONFIG
// ===========================================================================

function ConfigPanel({ actor, onSaved }: { actor: Actor; onSaved: (a: Actor) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [title, setTitle] = useState(actor.title ?? '');
  const [description, setDescription] = useState(actor.description ?? '');
  const [image, setImage] = useState(actor.defaultRunOptions?.image ?? '');
  const [build, setBuild] = useState(actor.defaultRunOptions?.build ?? '');
  const [timeoutSecs, setTimeoutSecs] = useState<number | ''>(
    actor.defaultRunOptions?.timeoutSecs ?? ''
  );
  const [memoryMbytes, setMemoryMbytes] = useState<number | ''>(
    actor.defaultRunOptions?.memoryMbytes ?? ''
  );
  const [maxRetries, setMaxRetries] = useState<number | ''>(actor.maxRetries ?? '');
  const [retryDelaySecs, setRetryDelaySecs] = useState<number | ''>(actor.retryDelaySecs ?? '');
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>(
    Object.entries(actor.defaultRunOptions?.envVars ?? {}).map(([key, value]) => ({ key, value }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [overrideInput, setOverrideInput] = useState('');
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideReplaceMode, setOverrideReplaceMode] = useState(false);

  async function handleSaveOverride() {
    if (!overrideInput.trim()) return;
    setOverrideBusy(true);
    try {
      const updated = await updateActor(actor.id, { proxyPassword: overrideInput.trim() });
      setOverrideInput('');
      setOverrideReplaceMode(false);
      onSaved(updated);
      toast.success('Proxy override saved for this actor');
    } catch (err) {
      toast.error('Failed to save', { description: (err as Error).message });
    } finally {
      setOverrideBusy(false);
    }
  }

  async function handleClearOverride() {
    const ok = await confirm({
      tone: 'danger',
      title: 'Remove actor proxy override?',
      description:
        'This actor will fall back to your account proxy password (or the platform default).',
      confirmLabel: 'remove',
    });
    if (!ok) return;
    setOverrideBusy(true);
    try {
      const updated = await updateActor(actor.id, { proxyPassword: null });
      onSaved(updated);
      toast.success('Override removed');
    } catch (err) {
      toast.error('Failed to remove', { description: (err as Error).message });
    } finally {
      setOverrideBusy(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const env: Record<string, string> = {};
      for (const { key, value } of envVars) {
        if (key.trim()) env[key.trim()] = value;
      }
      const updated = await updateActor(actor.id, {
        title: title || undefined,
        description: description || undefined,
        defaultRunOptions: {
          image: image || undefined,
          build: build || undefined,
          timeoutSecs: timeoutSecs === '' ? undefined : Number(timeoutSecs),
          memoryMbytes: memoryMbytes === '' ? undefined : Number(memoryMbytes),
          envVars: Object.keys(env).length ? env : undefined,
        },
        maxRetries: maxRetries === '' ? undefined : Number(maxRetries),
        retryDelaySecs: retryDelaySecs === '' ? undefined : Number(retryDelaySecs),
      });
      onSaved(updated);
      setSavedAt(Date.now());
      toast.success('Config saved');
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error('Failed to save config', { description: msg });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="panel p-6 lg:col-span-2 space-y-6">
          <header>
            <p className="eyebrow">CONFIG · METADATA</p>
            <h2 className="text-base mt-1">Identity & description</h2>
          </header>

          <Field label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Human-readable title"
              className="w-full h-9 px-3 rounded-sm border border-border bg-background text-[13px] text-foreground focus:outline-none focus:border-signal/50"
            />
          </Field>

          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-sm border border-border bg-background text-[13px] text-foreground resize-y focus:outline-none focus:border-signal/50"
            />
          </Field>

          <header className="pt-4 border-t border-border">
            <p className="eyebrow">CONFIG · DEFAULT RUN OPTIONS</p>
            <h2 className="text-base mt-1">Container defaults</h2>
          </header>

          <Field
            label="Image"
            hint="Full image reference. Set by `crc push` — usually leave blank."
          >
            <input
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="ghcr.io/org/repo/actor-foo:latest"
              className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Build tag">
              <input
                value={build}
                onChange={(e) => setBuild(e.target.value)}
                placeholder="latest"
                className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
              />
            </Field>
            <Field label="Default timeout · seconds">
              <input
                type="number"
                value={timeoutSecs}
                onChange={(e) =>
                  setTimeoutSecs(e.target.value === '' ? '' : Number(e.target.value))
                }
                placeholder="3600"
                className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
              />
            </Field>
            <Field label="Default memory · MB">
              <input
                type="number"
                value={memoryMbytes}
                onChange={(e) =>
                  setMemoryMbytes(e.target.value === '' ? '' : Number(e.target.value))
                }
                placeholder="1024"
                className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
              />
            </Field>
            <Field label="Max retries">
              <input
                type="number"
                value={maxRetries}
                onChange={(e) => setMaxRetries(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="0"
                className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
              />
            </Field>
            <Field label="Retry delay · seconds">
              <input
                type="number"
                value={retryDelaySecs}
                onChange={(e) =>
                  setRetryDelaySecs(e.target.value === '' ? '' : Number(e.target.value))
                }
                placeholder="60"
                className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
              />
            </Field>
          </div>

          {/* Env vars editor */}
          <div className="space-y-2">
            <Label>Environment variables</Label>
            <div className="space-y-1.5">
              {envVars.map((row, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <input
                    value={row.key}
                    onChange={(e) =>
                      setEnvVars((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r))
                      )
                    }
                    placeholder="KEY"
                    className="w-44 h-8 px-2 rounded-sm border border-border bg-background font-mono text-[11px] text-foreground focus:outline-none focus:border-signal/50"
                  />
                  <span className="text-muted-foreground font-mono text-[11px]">=</span>
                  <input
                    value={row.value}
                    onChange={(e) =>
                      setEnvVars((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r))
                      )
                    }
                    placeholder="value"
                    className="flex-1 h-8 px-2 rounded-sm border border-border bg-background font-mono text-[11px] text-foreground focus:outline-none focus:border-signal/50"
                  />
                  <button
                    type="button"
                    onClick={() => setEnvVars((prev) => prev.filter((_, i) => i !== idx))}
                    className="h-8 w-8 grid place-items-center text-muted-foreground hover:text-fail border border-border rounded-sm"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setEnvVars((prev) => [...prev, { key: '', value: '' }])}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider border border-dashed border-border text-muted-foreground hover:border-signal/50 hover:text-signal rounded-sm"
              >
                <Plus className="h-3 w-3" /> add var
              </button>
            </div>
          </div>

          {error && (
            <p className="font-mono text-[11px] text-fail border border-fail/30 bg-fail/5 p-2 rounded-sm">
              [ERR] {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
            {savedAt && (
              <span className="font-mono text-[10px] text-signal tracking-widest">
                [SAVED · {new Date(savedAt).toISOString().split('T')[1].slice(0, 8)}]
              </span>
            )}
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="h-9 px-4 inline-flex items-center gap-2 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </button>
          </div>
        </section>

        {/* Side panel — operator notes */}
        <aside className="panel p-6 space-y-4">
          <p className="eyebrow">NOTES</p>
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            Defaults here apply to every run unless overridden at run time (
            <code className="font-mono text-foreground">crc run -e KEY=val</code>).
          </p>
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            Env precedence:{' '}
            <span className="font-mono text-foreground">base &lt; actor &lt; runtime</span>.
          </p>
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            Image is set automatically by{' '}
            <code className="font-mono text-foreground">crc push</code>; only override if
            you&apos;re pulling from an external registry.
          </p>
        </aside>
      </div>

      {/* PROXY OVERRIDE */}
      <section className="panel">
        <header className="px-5 py-4 border-b border-border flex items-center gap-3">
          <Globe className="h-4 w-4 text-signal" />
          <div>
            <p className="eyebrow">CONFIG · PROXY OVERRIDE</p>
            <h2 className="text-[15px] mt-1">Per-actor Apify Proxy password</h2>
          </div>
        </header>

        <div className="p-5 space-y-4">
          {actor.hasProxyOverride && !overrideReplaceMode ? (
            <div className="flex items-center justify-between">
              <div>
                <Badge variant="success" shape="chip" className="px-2">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  <span>override active</span>
                </Badge>
                <p className="text-[12px] text-muted-foreground mt-2">
                  This actor uses a dedicated proxy password, ignoring account/platform defaults.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOverrideReplaceMode(true)}
                  className="h-9 px-3 inline-flex items-center text-[12px] font-mono uppercase tracking-wider border border-border rounded-sm text-muted-foreground hover:text-foreground hover:border-signal/40"
                >
                  replace
                </button>
                <button
                  type="button"
                  onClick={() => void handleClearOverride()}
                  disabled={overrideBusy}
                  className="h-9 px-3 inline-flex items-center text-[12px] font-mono uppercase tracking-wider border border-border rounded-sm text-fail hover:bg-fail/10 disabled:opacity-50"
                >
                  remove
                </button>
              </div>
            </div>
          ) : (
            <div>
              {!actor.hasProxyOverride && (
                <p className="text-[12px] text-muted-foreground mb-3">
                  <span className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
                    [ not set ]
                  </span>{' '}
                  This actor will use your account proxy password (or the platform default if none).
                </p>
              )}
              <div className="flex gap-2">
                <input
                  type="password"
                  value={overrideInput}
                  onChange={(e) => setOverrideInput(e.target.value)}
                  placeholder="apify proxy password"
                  className="flex-1 h-9 px-3 rounded-sm border border-border bg-input text-[13px] text-foreground placeholder:text-muted-foreground font-mono focus:outline-none focus:border-signal/50"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && overrideInput.trim()) {
                      e.preventDefault();
                      void handleSaveOverride();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleSaveOverride()}
                  disabled={overrideBusy || !overrideInput.trim()}
                  className="h-9 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50"
                >
                  {overrideBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  save
                </button>
                {overrideReplaceMode && (
                  <button
                    type="button"
                    onClick={() => {
                      setOverrideReplaceMode(false);
                      setOverrideInput('');
                    }}
                    className="h-9 px-3 inline-flex items-center text-[12px] font-mono uppercase tracking-wider border border-border rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    cancel
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ===========================================================================
// BUILDS
// ===========================================================================

function BuildsPanel({
  actor,
  builds,
  setBuilds,
}: {
  actor: Actor;
  builds: ActorBuild[];
  setBuilds: React.Dispatch<React.SetStateAction<ActorBuild[]>>;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [showForm, setShowForm] = useState(false);
  const [versionNumber, setVersionNumber] = useState('0.0.1');
  const [sourceUrl, setSourceUrl] = useState('');
  const [buildTag, setBuildTag] = useState('latest');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStartBuild() {
    setSubmitting(true);
    setError(null);
    try {
      const build = await startBuild(actor.id, {
        versionNumber,
        sourceType: sourceUrl ? 'GIT' : 'TARBALL',
        sourceUrl: sourceUrl || undefined,
        buildTag,
      });
      setBuilds((prev) => [build, ...prev]);
      setShowForm(false);
      toast.success('Build queued', { description: `${versionNumber} · ${buildTag}` });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAbort(buildId: string) {
    const ok = await confirm({
      tone: 'warn',
      title: 'Abort this build?',
      description: 'The build worker will stop after the current step. Image will not be pushed.',
      confirmLabel: 'abort build',
    });
    if (!ok) return;
    try {
      const updated = await abortBuild(actor.id, buildId);
      setBuilds((prev) => prev.map((b) => (b.id === buildId ? updated : b)));
      toast.success('Build aborted');
    } catch (err) {
      toast.error('Failed to abort build', { description: (err as Error).message });
    }
  }

  return (
    <div className="space-y-6">
      <section className="panel">
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <p className="eyebrow">BUILD · HISTORY</p>
            <h2 className="text-base mt-1">Image builds</h2>
          </div>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/50 hover:text-signal rounded-sm"
          >
            <Plus className="h-3.5 w-3.5" /> new build
          </button>
        </header>

        {showForm && (
          <div className="border-b border-border bg-secondary/30 px-5 py-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="Version">
                <input
                  value={versionNumber}
                  onChange={(e) => setVersionNumber(e.target.value)}
                  className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
                />
              </Field>
              <Field label="Build tag">
                <input
                  value={buildTag}
                  onChange={(e) => setBuildTag(e.target.value)}
                  className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
                />
              </Field>
              <Field label="Git source URL · optional">
                <input
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[11px] text-foreground focus:outline-none focus:border-signal/50"
                />
              </Field>
            </div>
            {error && <p className="font-mono text-[11px] text-fail">[ERR] {error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="h-8 px-3 text-[12px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={() => void handleStartBuild()}
                disabled={submitting}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background rounded-sm disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Hammer className="h-3.5 w-3.5" />
                )}
                queue build
              </button>
            </div>
          </div>
        )}

        {builds.length === 0 ? (
          <div className="grid-bg p-12 text-center">
            <p className="font-mono text-[11px] tracking-wider text-muted-foreground">
              [ NO BUILDS YET ]
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              Push an image with <code className="font-mono text-foreground">crc push</code>, or
              queue one above.
            </p>
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-widest text-muted-foreground uppercase border-b border-border">
                <th className="px-5 py-2 font-normal">Build</th>
                <th className="px-5 py-2 font-normal">Status</th>
                <th className="px-5 py-2 font-normal">Source</th>
                <th className="px-5 py-2 font-normal">Image</th>
                <th className="px-5 py-2 font-normal text-right">When</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody>
              {builds.map((b) => (
                <tr
                  key={b.id}
                  className="border-b border-border/60 last:border-0 hover:bg-secondary/40 align-top"
                >
                  <td className="px-5 py-3">
                    <p className="font-mono text-foreground inline-flex items-center gap-1">
                      {b.id.slice(0, 12)}
                      <CopyButton value={b.id} label="Build ID" />
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground tracking-wider mt-1">
                      {b.logCount.toLocaleString()} log lines
                    </p>
                  </td>
                  <td className="px-5 py-3">
                    <StatusChip status={b.status} />
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px]">
                    {/*
                      Version + tag: the source-version "0.1" plus the tag
                      currently pointing at this build (typically "latest").
                      Only the actor's most-recent build holds the tag —
                      siblings show no chip — so the chip column also acts
                      as a "current pointer" indicator.
                    */}
                    {b.versionNumber && (
                      <p className="text-foreground flex items-center gap-1.5">
                        <span>{b.versionNumber}</span>
                        {b.buildTag && (
                          <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 border border-border rounded-sm text-muted-foreground">
                            {b.buildTag}
                          </span>
                        )}
                      </p>
                    )}
                    {b.gitBranch && (
                      <p className="text-muted-foreground flex items-center gap-1.5 mt-0.5">
                        <GitBranch className="h-3 w-3" />
                        {b.gitBranch}
                      </p>
                    )}
                    {b.gitCommit && (
                      <p className="text-muted-foreground flex items-center gap-1.5 mt-0.5">
                        <GitCommit className="h-3 w-3" />
                        {b.gitCommit.slice(0, 9)}
                      </p>
                    )}
                    {!b.versionNumber && !b.gitBranch && !b.gitCommit && (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground max-w-[260px]">
                    {b.imageName ? (
                      <>
                        <p className="text-foreground truncate" title={b.imageName}>
                          {b.imageName}
                        </p>
                        {b.imageDigest && (
                          <p className="truncate" title={b.imageDigest}>
                            {b.imageDigest.slice(0, 18)}…
                          </p>
                        )}
                        {b.imageSizeBytes && <p className="mt-0.5">{fmtBytes(b.imageSizeBytes)}</p>}
                      </>
                    ) : (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground tnum text-right">
                    {timeAgo(b.createdAt)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {(b.status === 'BUILDING' || b.status === 'PENDING') && (
                      <button
                        type="button"
                        onClick={() => void handleAbort(b.id)}
                        className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-fail"
                      >
                        abort
                      </button>
                    )}
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

// ===========================================================================
// WEBHOOKS (scoped to this actor)
// ===========================================================================

function WebhooksPanel({
  actor,
  webhooks,
  setWebhooks,
  runWebhooks,
}: {
  actor: Actor;
  webhooks: Webhook[];
  setWebhooks: React.Dispatch<React.SetStateAction<Webhook[]>>;
  /** Per-run hooks created via POST /v2/acts/:id/runs across recent runs of this actor. */
  runWebhooks: Webhook[];
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [showForm, setShowForm] = useState(false);
  const [requestUrl, setRequestUrl] = useState('https://');
  const [description, setDescription] = useState('');
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
        eventTypes: Array.from(selected),
        requestUrl,
        description: description || undefined,
        actorId: actor.id,
      });
      setWebhooks((prev) => [created, ...prev]);
      setShowForm(false);
      setRequestUrl('https://');
      setDescription('');
      toast.success('Webhook created', { description: created.requestUrl });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
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

  return (
    <section className="panel">
      <header className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <p className="eyebrow">INTEGRATE · DELIVERY</p>
          <h2 className="text-base mt-1">
            Webhooks <span className="text-muted-foreground">· scoped to this actor</span>
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/50 hover:text-signal rounded-sm"
        >
          <Plus className="h-3.5 w-3.5" /> new webhook
        </button>
      </header>

      {showForm && (
        <div className="border-b border-border bg-secondary/30 px-5 py-5 space-y-4">
          <Field label="Request URL">
            <input
              value={requestUrl}
              onChange={(e) => setRequestUrl(e.target.value)}
              placeholder="https://hooks.example.com/run"
              className="w-full h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50"
            />
          </Field>

          <Field label="Description · optional">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Posts to #scrapers in Slack"
              className="w-full h-9 px-3 rounded-sm border border-border bg-background text-[12px] text-foreground focus:outline-none focus:border-signal/50"
            />
          </Field>

          <div className="space-y-2">
            <Label>Events</Label>
            <div className="space-y-3">
              {WEBHOOK_EVENTS.map((g) => (
                <div key={g.id}>
                  <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase mb-2">
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
                            isOn
                              ? 'border-signal/50 bg-signal/5'
                              : 'border-border hover:border-border/80 bg-background'
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
          </div>

          {error && <p className="font-mono text-[11px] text-fail">[ERR] {error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
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
        </div>
      )}

      {webhooks.length === 0 ? (
        <div className="grid-bg p-12 text-center">
          <p className="font-mono text-[11px] tracking-wider text-muted-foreground">
            [ NO WEBHOOKS ]
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {webhooks.map((w) => (
            <li key={w.id} className="px-5 py-4 hover:bg-secondary/30 group">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'font-mono text-[10px] tracking-widest px-1.5 py-0.5 rounded-sm border',
                        w.isEnabled
                          ? 'text-signal border-signal/40'
                          : 'text-muted-foreground border-border'
                      )}
                    >
                      {w.isEnabled ? '[LIVE]' : '[OFF]'}
                    </span>
                    <p className="font-mono text-[12px] text-foreground truncate">{w.requestUrl}</p>
                  </div>
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
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(w.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-fail"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Per-run history: hooks created via POST /acts/:id/runs across this
          actor's recent runs. Only rendered when at least one exists, so
          actors that don't use per-run hooks don't carry empty chrome.
          Full detail (payload template, headers, deliveries) lives on the
          run detail page Webhooks tab — this is a "you have per-run hooks,
          here's where to look" affordance. */}
      {runWebhooks.length > 0 && (
        <section className="border-t border-border">
          <header className="px-5 py-3 bg-secondary/30">
            <p className="eyebrow">PER-RUN HISTORY · {runWebhooks.length}</p>
            <p className="text-[12px] text-muted-foreground mt-1">
              Webhooks attached to specific runs of this actor. Open the run to see payload &amp;
              deliveries.
            </p>
          </header>
          <ul className="divide-y divide-border">
            {runWebhooks.map((w) => (
              <li key={w.id} className="px-5 py-3 hover:bg-secondary/30">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-mono text-[12px] text-foreground truncate">{w.requestUrl}</p>
                    <div className="flex flex-wrap gap-1">
                      {w.eventTypes.map((e) => (
                        <span
                          key={e}
                          className="font-mono text-[9px] text-muted-foreground border border-border px-1 py-0.5 rounded-sm"
                        >
                          {e.replace(/^ACTOR\.RUN\./, '')}
                        </span>
                      ))}
                    </div>
                  </div>
                  {w.runId && (
                    <AppLink
                      href={`/runs/${w.runId}`}
                      className="shrink-0 font-mono text-[10px] tracking-widest text-muted-foreground hover:text-signal uppercase"
                    >
                      run · {w.runId.slice(0, 8)} →
                    </AppLink>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

// ===========================================================================
// RUNS
// ===========================================================================

function RunsPanel({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <div className="panel grid-bg p-12 text-center">
        <p className="font-mono text-[11px] tracking-wider text-muted-foreground">
          [ NO RUNS YET ]
        </p>
      </div>
    );
  }
  return (
    <section className="panel">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left font-mono text-[10px] tracking-widest text-muted-foreground uppercase border-b border-border">
            <th className="px-5 py-2 font-normal">Run</th>
            <th className="px-5 py-2 font-normal">Status</th>
            <th className="px-5 py-2 font-normal">Duration</th>
            <th className="px-5 py-2 font-normal">Dataset</th>
            <th className="px-5 py-2 font-normal text-right">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.slice(0, 50).map((r) => (
            <tr
              key={r.id}
              className="border-b border-border/60 last:border-0 hover:bg-secondary/40"
            >
              <td className="px-5 py-3 font-mono">
                <span className="inline-flex items-center gap-1">
                  <AppLink href={`/runs/${r.id}`} className="text-foreground hover:text-signal">
                    {r.id.slice(0, 12)}
                  </AppLink>
                  <CopyButton value={r.id} label="Run ID" />
                </span>
              </td>
              <td className="px-5 py-3">
                <StatusChip status={r.status} />
              </td>
              <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground tnum">
                {fmtRunDuration(r.startedAt, r.finishedAt)}
              </td>
              <td className="px-5 py-3">
                {r.defaultDatasetId ? (
                  <AppLink
                    href={`/datasets/${r.defaultDatasetId}`}
                    className="font-mono text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  >
                    <Database className="h-3 w-3" />
                    {r.defaultDatasetId.slice(0, 10)}
                  </AppLink>
                ) : (
                  <span className="text-muted-foreground/40">—</span>
                )}
              </td>
              <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground tnum text-right">
                {timeAgo(r.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ===========================================================================
// SHARED PRIMITIVES
// ===========================================================================

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
      {children}
    </label>
  );
}

function DefRow({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="eyebrow mb-1">{label}</p>
      <p className={cn('text-[12px] text-foreground', mono && 'font-mono')}>{children}</p>
    </div>
  );
}

// ===========================================================================
// FORMATTERS
// ===========================================================================

function fmtRunDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  return fmtDuration(Math.floor((end - start) / 1000));
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
