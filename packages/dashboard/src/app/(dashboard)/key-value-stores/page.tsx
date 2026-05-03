'use client';

import { useEffect, useState } from 'react';
import { Boxes, Search, Trash2 } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { Pagination } from '@/components/pagination';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { deleteKeyValueStore, getKeyValueStores, type KeyValueStore } from '@/lib/api';
import { PAGE_SIZE } from '@/lib/constants';
import { usePageParam } from '@/lib/use-page-param';

export default function KeyValueStoresPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { offset, setOffset } = usePageParam();
  const [stores, setStores] = useState<KeyValueStore[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let alive = true;
    getKeyValueStores({ offset, limit: PAGE_SIZE })
      .then((p) => {
        if (!alive) return;
        setStores(p.items);
        setTotal(p.total);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [offset]);

  async function handleDelete(s: KeyValueStore) {
    const ok = await confirm({
      tone: 'danger',
      title: `Delete KV store?`,
      description: 'All keys and values are removed from S3 permanently. Cannot be undone.',
      confirmLabel: 'delete store',
    });
    if (!ok) return;
    try {
      await deleteKeyValueStore(s.id);
      setStores((prev) => prev.filter((x) => x.id !== s.id));
      toast.success('Store deleted');
    } catch (err) {
      toast.error('Failed to delete store', { description: (err as Error).message });
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? stores.filter(
        (s) => s.id.toLowerCase().includes(q) || (s.name?.toLowerCase().includes(q) ?? false)
      )
    : stores;

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <p className="eyebrow mb-2">DATA · KEY-VALUE STORES</p>
        <h1 className="text-[28px] leading-none font-medium tracking-tight">KV Stores</h1>
        <p className="text-muted-foreground mt-2 text-[13px]">
          Per-run scratch space for INPUT, OUTPUT, and arbitrary actor state.
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search by id or name"
          className="w-full h-9 pl-9 pr-3 rounded-sm border border-border bg-input text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-signal/50"
        />
      </div>

      <section className="panel">
        {loading ? (
          <div className="grid-bg p-12 text-center">
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              [ LOADING · · · ]
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="grid-bg p-16 text-center">
            <Boxes className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              {search ? '[ NO MATCH ]' : '[ NO KV STORES YET ]'}
            </p>
            <p className="text-[13px] text-muted-foreground mt-2">
              Stores are created automatically on every actor run.
            </p>
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-widest text-muted-foreground uppercase border-b border-border">
                <th className="px-5 py-2 font-normal">Store</th>
                <th className="px-5 py-2 font-normal text-right">Created</th>
                <th className="px-5 py-2 font-normal text-right">Last accessed</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-border/60 last:border-0 hover:bg-secondary/40"
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-7 w-7 rounded-sm border border-border bg-secondary/60 grid place-items-center text-muted-foreground">
                        <Boxes className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0">
                        {s.name && <p className="text-foreground text-[13px] truncate">{s.name}</p>}
                        <AppLink
                          href={`/key-value-stores/${s.id}`}
                          className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          {s.id.slice(0, 16)}
                        </AppLink>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-[11px] text-muted-foreground tnum">
                    {timeAgo(s.createdAt)}
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-[11px] text-muted-foreground tnum">
                    {timeAgo(s.accessedAt)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      title="Delete"
                      onClick={() => void handleDelete(s)}
                      className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-fail border border-transparent hover:border-border rounded-sm"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Pagination total={total} offset={offset} limit={PAGE_SIZE} onChange={setOffset} />
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
