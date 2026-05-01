'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  HardDrive,
  Loader2,
  Plus,
  Settings2,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { createApiKey, getApiKeys, revokeApiKey, type ApiKey } from '@/lib/api';
import { cn } from '@/lib/utils';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export default function SettingsPage() {
  const confirm = useConfirm();
  const toast = useToast();

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [showNewKey, setShowNewKey] = useState(false);

  const loadKeys = useCallback(async () => {
    try {
      const keys = await getApiKeys();
      setApiKeys(keys);
    } catch {
      // Empty list on failure; the API may simply be unreachable.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  async function handleCreate() {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const { key } = await createApiKey(newKeyName.trim());
      setNewlyCreatedKey(key);
      setNewKeyName('');
      await loadKeys();
      toast.success('API key created', { description: 'Copy it now — visible only once.' });
    } catch (err) {
      toast.error('Failed to create key', { description: (err as Error).message });
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(key: ApiKey) {
    const ok = await confirm({
      tone: 'danger',
      title: `Revoke "${key.name}"?`,
      description: 'Anything using this key — CLI, SDKs, scripts — will stop working immediately.',
      confirmLabel: 'revoke key',
    });
    if (!ok) return;
    try {
      await revokeApiKey(key.id);
      await loadKeys();
      toast.success('Key revoked');
    } catch (err) {
      toast.error('Failed to revoke key', { description: (err as Error).message });
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Copy failed');
    }
  }

  return (
    <div className="space-y-8 max-w-4xl">
      <header className="pb-4 border-b border-border">
        <p className="eyebrow mb-2">SYSTEM · SETTINGS</p>
        <h1 className="text-[28px] leading-none font-medium tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-2 text-[13px]">
          API access, storage backends, and execution defaults.
        </p>
      </header>

      {/* API ACCESS */}
      <section className="panel">
        <header className="px-5 py-4 border-b border-border flex items-center gap-3">
          <Shield className="h-4 w-4 text-signal" />
          <div>
            <p className="eyebrow">AUTH · API ACCESS</p>
            <h2 className="text-[15px] mt-1">Connection details &amp; tokens</h2>
          </div>
        </header>

        <div className="p-5 space-y-5">
          {/* Base URL */}
          <Field label="API base URL">
            <div className="flex gap-2">
              <input
                value={API_BASE}
                readOnly
                onClick={(e) => e.currentTarget.select()}
                className="flex-1 h-9 px-3 rounded-sm border border-border bg-input font-mono text-[12px] text-foreground"
              />
              <button
                type="button"
                onClick={() => void copy(API_BASE, 'Base URL')}
                title="Copy"
                className="h-9 w-9 grid place-items-center border border-border rounded-sm text-muted-foreground hover:text-foreground hover:border-signal/40"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </Field>

          {/* Newly created key — show ONCE */}
          {newlyCreatedKey && (
            <div className="panel border-l-2 border-l-signal p-4 space-y-3 bg-signal/5">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[10px] tracking-widest text-signal uppercase">
                  [ NEW KEY · COPY NOW ]
                </p>
                <button
                  type="button"
                  onClick={() => setNewlyCreatedKey(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="text-[12px] text-muted-foreground">
                This is the only time the key will be shown — store it somewhere safe.
              </p>
              <div className="flex gap-2">
                <input
                  type={showNewKey ? 'text' : 'password'}
                  value={newlyCreatedKey}
                  readOnly
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="flex-1 h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground"
                />
                <button
                  type="button"
                  title={showNewKey ? 'Hide' : 'Reveal'}
                  onClick={() => setShowNewKey((s) => !s)}
                  className="h-9 w-9 grid place-items-center border border-border rounded-sm text-muted-foreground hover:text-foreground"
                >
                  {showNewKey ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void copy(newlyCreatedKey, 'API key')}
                  className="h-9 px-3 inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider border border-border rounded-sm text-muted-foreground hover:text-foreground hover:border-signal/40"
                >
                  <Copy className="h-3.5 w-3.5" /> copy
                </button>
              </div>
            </div>
          )}

          {/* Create new key */}
          <Field label="Generate new API key">
            <div className="flex gap-2">
              <input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="key name (e.g. CLI access)"
                className="flex-1 h-9 px-3 rounded-sm border border-border bg-input text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-signal/50"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newKeyName.trim()) {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
              />
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating || !newKeyName.trim()}
                className="h-9 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                generate
              </button>
            </div>
          </Field>

          {/* Existing keys */}
          <div className="space-y-2">
            <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
              Active keys
            </p>
            {loading ? (
              <p className="text-[12px] text-muted-foreground font-mono">[ loading · · · ]</p>
            ) : apiKeys.filter((k) => k.isActive).length === 0 ? (
              <div className="grid-bg p-8 text-center border border-border rounded-sm">
                <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
                  [ NO API KEYS ]
                </p>
                <p className="text-[12px] text-muted-foreground mt-1">
                  Generate one above to use the CLI or SDKs.
                </p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {apiKeys
                  .filter((k) => k.isActive)
                  .map((key) => (
                    <li
                      key={key.id}
                      className="flex items-center justify-between p-3 panel hover:bg-secondary/30 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-foreground text-[13px]">{key.name}</p>
                        <p className="font-mono text-[11px] text-muted-foreground mt-0.5">
                          {key.keyPreview}
                          {key.lastUsedAt && (
                            <>
                              <span className="mx-2">·</span>
                              last used {timeAgo(key.lastUsedAt)}
                            </>
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        title="Revoke"
                        onClick={() => void handleRevoke(key)}
                        className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-fail border border-transparent hover:border-border rounded-sm"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* STORAGE BACKENDS */}
      <section className="panel">
        <header className="px-5 py-4 border-b border-border flex items-center gap-3">
          <HardDrive className="h-4 w-4 text-signal" />
          <div>
            <p className="eyebrow">SYSTEM · STORAGE</p>
            <h2 className="text-[15px] mt-1">Connected backends</h2>
          </div>
        </header>
        <ul className="divide-y divide-border">
          {STORAGE_BACKENDS.map((b) => (
            <li key={b.label} className="flex items-center justify-between px-5 py-3">
              <div className="min-w-0">
                <p className="text-foreground text-[13px]">{b.label}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{b.description}</p>
              </div>
              <Badge variant="success" shape="chip" className="px-2">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                <span>connected</span>
              </Badge>
            </li>
          ))}
        </ul>
      </section>

      {/* EXECUTION DEFAULTS */}
      <section className="panel">
        <header className="px-5 py-4 border-b border-border flex items-center gap-3">
          <Settings2 className="h-4 w-4 text-signal" />
          <div>
            <p className="eyebrow">SYSTEM · EXECUTION DEFAULTS</p>
            <h2 className="text-[15px] mt-1">Used by every new run</h2>
          </div>
        </header>
        <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Concurrency limit" hint="Max simultaneous runs">
            <input type="number" defaultValue={10} className={INPUT_CLASS} />
          </Field>
          <Field label="Default memory · MB" hint="Container memory limit">
            <input type="number" defaultValue={1024} className={INPUT_CLASS} />
          </Field>
          <Field label="Default timeout · sec" hint="Hard execution limit">
            <input type="number" defaultValue={3600} className={INPUT_CLASS} />
          </Field>
        </div>
        <footer className="px-5 py-3 border-t border-border bg-secondary/30 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
          Read-only — server-driven values, edit via env vars on the API.
        </footer>
      </section>
    </div>
  );
}

const INPUT_CLASS = cn(
  'w-full h-9 px-3 rounded-sm border border-border bg-input font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50'
);

const STORAGE_BACKENDS = [
  { label: 'PostgreSQL', description: 'Primary metadata store' },
  { label: 'Redis', description: 'Job queue · log buffer · cache' },
  { label: 'MinIO / S3', description: 'Dataset items + KV store records' },
];

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
      <label className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
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
