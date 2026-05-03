'use client';

import { Fragment, use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Boxes,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileKey,
  Loader2,
  Trash2,
} from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { prefixPath } from '@/lib/path-prefix';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import {
  deleteKeyValueStore,
  fetchKVRecordContent,
  findProducingRun,
  getActor,
  getKeyValueStore,
  getKVKeys,
  openInTabAsBlob,
  type Actor,
  type KeyValueStore,
  type KVKey,
  type Run,
} from '@/lib/api';
import { KV_KEYS_PREVIEW_LIMIT } from '@/lib/constants';

export default function KVStoreDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();

  const [store, setStore] = useState<KeyValueStore | null>(null);
  const [keys, setKeys] = useState<KVKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [keysLoading, setKeysLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  // Backlink: which run produced this store (and that run's actor)?
  const [producingRun, setProducingRun] = useState<Run | null>(null);
  const [producingActor, setProducingActor] = useState<Actor | null>(null);
  // Inline content preview state — keyed by record key. Each value is a
  // tri-state (loading / loaded with content / error string). Caching here
  // means re-expanding is instant and we don't refetch on every collapse.
  const [previewByKey, setPreviewByKey] = useState<
    Record<
      string,
      | { state: 'loading' }
      | { state: 'loaded'; text: string; truncated: boolean; size: number; contentType: string }
      | { state: 'error'; message: string }
    >
  >({});
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  async function togglePreview(key: string) {
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (previewByKey[key]) return; // cached
    setPreviewByKey((prev) => ({ ...prev, [key]: { state: 'loading' } }));
    try {
      const content = await fetchKVRecordContent(id, key);
      if (!content) {
        setPreviewByKey((prev) => ({
          ...prev,
          [key]: { state: 'error', message: 'Record not found' },
        }));
        return;
      }
      setPreviewByKey((prev) => ({ ...prev, [key]: { state: 'loaded', ...content } }));
    } catch (err) {
      setPreviewByKey((prev) => ({
        ...prev,
        [key]: { state: 'error', message: (err as Error).message },
      }));
    }
  }

  useEffect(() => {
    let alive = true;
    void Promise.all([
      getKeyValueStore(id).catch(() => null),
      getKVKeys(id, { limit: KV_KEYS_PREVIEW_LIMIT }).catch(() => ({
        items: [],
        isTruncated: false,
        nextExclusiveStartKey: null,
      })),
    ]).then(([s, k]) => {
      if (!alive) return;
      setStore(s);
      setKeys(k.items);
      setTruncated(k.isTruncated);
      setLoading(false);
      setKeysLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  // Lazy reverse-lookup once the store is loaded.
  useEffect(() => {
    if (!store) return;
    let alive = true;
    findProducingRun('kv', store.id)
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
  }, [store]);

  async function handleDelete() {
    const ok = await confirm({
      tone: 'danger',
      title: 'Delete this KV store?',
      description: 'All keys and values are removed permanently. Cannot be undone.',
      confirmLabel: 'delete store',
    });
    if (!ok) return;
    try {
      await deleteKeyValueStore(id);
      toast.success('Store deleted');
      router.push(prefixPath('/key-value-stores'));
    } catch (err) {
      toast.error('Failed to delete store', { description: (err as Error).message });
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center min-h-[40vh]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!store) {
    return (
      <div className="grid place-items-center min-h-[40vh] text-center">
        <div>
          <p className="font-mono text-[11px] tracking-widest text-muted-foreground mb-2">
            [ STORE NOT FOUND ]
          </p>
          <AppLink href="/key-value-stores" className="text-[13px] hover:text-signal">
            ← back to stores
          </AppLink>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <AppLink
        href="/key-value-stores"
        className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-muted-foreground hover:text-foreground uppercase"
      >
        <ArrowLeft className="h-3 w-3" /> kv stores
      </AppLink>

      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 pb-5 border-b border-border">
        <div className="space-y-2 min-w-0">
          <p className="eyebrow">KV STORE · {store.id.slice(0, 12)}</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight truncate">
            {store.name || 'Unnamed store'}
          </h1>
          <p className="font-mono text-[11px] text-muted-foreground">{store.id}</p>
        </div>
        <button
          type="button"
          onClick={() => void handleDelete()}
          className="h-8 px-3 self-start md:self-auto inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border text-muted-foreground hover:border-fail/40 hover:text-fail rounded-sm"
        >
          <Trash2 className="h-3.5 w-3.5" /> delete
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border border border-border rounded-md overflow-hidden">
        <Tile label="Keys">
          {keys.length}
          {truncated ? '+' : ''}
        </Tile>
        <Tile label="Created">{new Date(store.createdAt).toLocaleString()}</Tile>
        <Tile label="Last accessed">{new Date(store.accessedAt).toLocaleString()}</Tile>
      </div>

      {/* Producer backlink — useful for hash-named stores where the ID alone tells you nothing. */}
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

      {/* Keys */}
      <section className="panel">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2">
          <FileKey className="h-3.5 w-3.5 text-signal" />
          <span className="text-[13px] text-foreground">Keys</span>
          {truncated && (
            <span className="font-mono text-[10px] text-muted-foreground tracking-wider">
              · first 100 shown
            </span>
          )}
        </header>
        {keysLoading ? (
          <div className="p-12 text-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto" />
          </div>
        ) : keys.length === 0 ? (
          <div className="grid-bg p-16 text-center">
            <Boxes className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              [ EMPTY · NO KEYS ]
            </p>
            <p className="text-[13px] text-muted-foreground mt-2">
              Records appear here once an actor writes to this store.
            </p>
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-widest text-muted-foreground uppercase border-b border-border">
                <th className="px-5 py-2 font-normal w-6"></th>
                <th className="px-5 py-2 font-normal">Key</th>
                <th className="px-5 py-2 font-normal text-right">Size</th>
                <th className="px-5 py-2 font-normal text-right w-24">Raw</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const isExpanded = expandedKey === k.key;
                const preview = previewByKey[k.key];
                return (
                  <Fragment key={k.key}>
                    <tr
                      onClick={() => void togglePreview(k.key)}
                      className="border-b border-border/60 last:border-0 hover:bg-secondary/40 cursor-pointer"
                    >
                      <td className="px-3 py-3 text-muted-foreground">
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </td>
                      <td className="px-5 py-3 font-mono text-foreground">{k.key}</td>
                      <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground tnum text-right">
                        {fmtBytes(k.size)}
                      </td>
                      <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        {/* "view" → fetches a 1-hour presigned S3 URL and opens it
                            in a new tab. The dashboard never touches the record
                            bytes — the browser streams directly from S3, so even
                            a 50MB binary doesn't dent JS heap. Used for binary
                            records or anything bigger than the inline cap. */}
                        <button
                          type="button"
                          onClick={() => void openRawRecord(id, k.key, toast)}
                          className="inline-flex items-center gap-1 font-mono text-[10px] tracking-wider text-muted-foreground hover:text-signal uppercase"
                        >
                          view <ExternalLink className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-border/60">
                        <td colSpan={4} className="px-5 py-3 bg-secondary/30">
                          <RecordPreview
                            preview={preview}
                            onOpenRaw={() => void openRawRecord(id, k.key, toast)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card px-5 py-4">
      <p className="eyebrow mb-2">{label}</p>
      <div className="text-foreground text-[15px] leading-tight tnum truncate">{children}</div>
    </div>
  );
}

/**
 * Open a KV record in a new tab via the blob-URL path. Same robustness
 * properties as the runs-page "view raw" — content type is explicit, no
 * filename hint, browsers reliably render inline.
 *
 * We use this instead of the presigned-URL flow for the in-dashboard view
 * because it works deterministically across browsers without depending on
 * MinIO/S3 honouring `response-content-disposition`. The presigned URL path
 * stays available in the API for non-dashboard consumers (CLI, share links).
 */
async function openRawRecord(
  storeId: string,
  key: string,
  toast: { error: (m: string, opts?: { description?: string }) => void }
): Promise<void> {
  try {
    // We don't know the content type up front; default to text/plain so
    // unknown payloads are at least readable. Common types (json, html)
    // will be re-tagged by the browser based on body sniffing for blob URLs
    // — but the explicit MIME we pass is what determines the tab behavior.
    await openInTabAsBlob(
      `/v2/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(key)}`,
      // application/json covers INPUT/OUTPUT and most common KV writes;
      // for non-JSON payloads the user can still see / save the raw text.
      'application/json; charset=utf-8'
    );
  } catch (err) {
    toast.error('Could not open record', { description: (err as Error).message });
  }
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Inline preview for an expanded KV record. Pretty-prints JSON when the
 * content parses; otherwise renders raw text. Detects binary by looking
 * for null bytes in the first ~200 chars and short-circuits to "view raw"
 * — pretty-printing a JPEG inline would just be noise.
 *
 * Clamped to maxHeight with `overflow-y: auto` so a 200-line error array
 * doesn't push the entire keys table off-screen.
 */
function RecordPreview({
  preview,
  onOpenRaw,
}: {
  preview:
    | { state: 'loading' }
    | { state: 'loaded'; text: string; truncated: boolean; size: number; contentType: string }
    | { state: 'error'; message: string }
    | undefined;
  onOpenRaw: () => void;
}) {
  if (!preview || preview.state === 'loading') {
    return (
      <div className="grid place-items-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (preview.state === 'error') {
    return <p className="font-mono text-[11px] text-fail">[ERR] {preview.message}</p>;
  }

  const { text, truncated, size, contentType } = preview;
  // Binary heuristic: control chars (excluding tab/newline/CR) in the first
  // 200 bytes mean it's not text we should pretty-print. Disable the lint
  // rule — control chars are exactly what we're matching by design.
  // eslint-disable-next-line no-control-regex
  const looksBinary = /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 200));

  let display: string;
  let parsedAsJson = false;
  if (looksBinary) {
    display = '';
  } else {
    try {
      display = JSON.stringify(JSON.parse(text), null, 2);
      parsedAsJson = true;
    } catch {
      display = text;
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        <span>
          {parsedAsJson ? 'JSON' : 'TEXT'} · {fmtBytes(size)} · {contentType}
          {truncated && ' · truncated'}
        </span>
        {(truncated || looksBinary) && (
          <button
            type="button"
            onClick={onOpenRaw}
            className="inline-flex items-center gap-1 hover:text-signal"
          >
            view full <ExternalLink className="h-3 w-3" />
          </button>
        )}
      </div>
      {looksBinary ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          [ Binary record — open in new tab to view ]
        </p>
      ) : (
        <pre className="font-mono text-[11px] text-foreground bg-background border border-border rounded-sm p-3 overflow-auto max-h-96 whitespace-pre-wrap break-all">
          {display}
        </pre>
      )}
    </div>
  );
}
