'use client';

import { Suspense, useEffect, useState } from 'react';
import { Database, Download, Eye, Search, Trash2 } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { Pagination } from '@/components/pagination';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import type { Dataset } from '@/lib/api';
import { deleteDataset, getDatasetItems, getDatasets } from '@/lib/api';
import { PAGE_SIZE } from '@/lib/constants';
import { useDebouncedSearch } from '@/lib/use-debounced-search';
import { usePageParam } from '@/lib/use-page-param';

function DatasetsContent() {
  const confirm = useConfirm();
  const toast = useToast();
  const { offset, setOffset, query, setQuery } = usePageParam();
  const [search, setSearch] = useDebouncedSearch(query, setQuery);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getDatasets({ offset, limit: PAGE_SIZE, q: query })
      .then((p) => {
        if (!alive) return;
        setDatasets(p.items);
        setTotal(p.total);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [offset, query]);

  async function handleDelete(id: string) {
    const ok = await confirm({
      tone: 'danger',
      title: 'Delete dataset?',
      description: 'Items and metadata are deleted from S3 and PostgreSQL. Cannot be undone.',
      confirmLabel: 'delete dataset',
    });
    if (!ok) return;
    try {
      await deleteDataset(id);
      setDatasets((prev) => prev.filter((d) => d.id !== id));
      toast.success('Dataset deleted');
    } catch (err) {
      toast.error('Failed to delete dataset', { description: (err as Error).message });
    }
  }

  async function handleDownload(id: string) {
    try {
      const items = await getDatasetItems(id);
      const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dataset-${id.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Dataset downloaded', { description: `${items.length} items` });
    } catch (err) {
      toast.error('Download failed', { description: (err as Error).message });
    }
  }

  // Server-side search returns the already-filtered page. The local
  // `filtered` alias kept here to minimise diff churn against existing
  // render logic.
  const filtered = datasets;

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <p className="eyebrow mb-2">DATA · DATASETS</p>
        <h1 className="text-[28px] leading-none font-medium tracking-tight">Datasets</h1>
        <p className="text-muted-foreground mt-2 text-[13px]">Records produced by actor runs.</p>
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
            <Database className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              {search ? '[ NO MATCH ]' : '[ NO DATASETS YET ]'}
            </p>
            <p className="text-[13px] text-muted-foreground mt-2">
              Run an actor to produce a dataset.
            </p>
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-widest text-muted-foreground uppercase border-b border-border">
                <th className="px-5 py-2 font-normal">Dataset</th>
                <th className="px-5 py-2 font-normal text-right">Items</th>
                <th className="px-5 py-2 font-normal text-right">Modified</th>
                <th className="px-5 py-2 font-normal text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr
                  key={d.id}
                  className="border-b border-border/60 last:border-0 hover:bg-secondary/40"
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-7 w-7 rounded-sm border border-border bg-secondary/60 grid place-items-center text-muted-foreground">
                        <Database className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0">
                        {d.name && <p className="text-foreground text-[13px] truncate">{d.name}</p>}
                        <AppLink
                          href={`/datasets/${d.id}`}
                          className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          {d.id.slice(0, 16)}
                        </AppLink>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-foreground tnum">
                    {d.itemCount.toLocaleString()}
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-[11px] text-muted-foreground tnum">
                    {timeAgo(d.modifiedAt)}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <AppLink
                        href={`/datasets/${d.id}`}
                        title="View"
                        className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-foreground border border-transparent hover:border-border rounded-sm"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </AppLink>
                      <button
                        type="button"
                        title="Download"
                        onClick={() => void handleDownload(d.id)}
                        className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-signal border border-transparent hover:border-border rounded-sm"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        onClick={() => void handleDelete(d.id)}
                        className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-fail border border-transparent hover:border-border rounded-sm"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
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

export default function DatasetsPage() {
  return (
    <Suspense fallback={<div className="grid-bg p-12" />}>
      <DatasetsContent />
    </Suspense>
  );
}
