"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Database, Download, Trash2, Loader2, Eye, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDatasets, getDatasetItems, deleteDataset, Dataset } from "@/lib/api";
import Link from "next/link";

function DatasetsContent() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  
  async function loadDatasets() {
    setLoading(true);
    try {
      const data = await getDatasets();
      setDatasets(data);
    } catch (err) {
      console.error('Failed to load datasets:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDatasets();
  }, []);

  async function handleDelete(id: string) {
    if (!confirm('Are you sure you want to delete this dataset?')) return;
    try {
      await deleteDataset(id);
      setDatasets(datasets.filter(d => d.id !== id));
    } catch (err) {
      console.error('Failed to delete dataset:', err);
    }
  }

  function handleDownload(id: string) {
    getDatasetItems(id).then(items => {
      downloadJSON(items, `dataset-${id.slice(0, 8)}.json`);
    }).catch(err => {
      console.error('Failed to download dataset:', err);
    });
  }

  function downloadJSON(data: unknown[], filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filtered = datasets.filter(d =>
    d.id.includes(search) || (d.name && d.name.includes(search))
  );

  function formatTimeAgo(date: string): string {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500 relative">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-linear-to-r from-white to-white/60 bg-clip-text text-transparent">Datasets</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Access and manage your scraped data collections
          </p>
        </div>
      </div>

      <div className="relative max-w-md w-full">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          placeholder="Search datasets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full h-10 rounded-lg border border-white/10 bg-white/5 pl-10 pr-3 py-1 text-sm text-white shadow-sm transition-all placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-pink-500/50 focus-visible:bg-white/10"
        />
      </div>

      <div className="rounded-xl border border-white/10 bg-black/20 overflow-hidden backdrop-blur-sm">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-10 w-10 animate-spin text-pink-500" />
          </div>
        ) : filtered.length > 0 ? (
          <Table>
            <TableHeader className="bg-white/5">
              <TableRow className="border-white/5 hover:bg-transparent">
                <TableHead className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">Name / ID</TableHead>
                <TableHead className="font-semibold text-muted-foreground text-xs uppercase tracking-wider text-right">Items</TableHead>
                <TableHead className="font-semibold text-muted-foreground text-xs uppercase tracking-wider text-right">Modified</TableHead>
                <TableHead className="font-semibold text-muted-foreground text-xs uppercase tracking-wider text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((dataset) => (
                <TableRow key={dataset.id} className="border-white/5 hover:bg-white/5 transition-colors">
                  <TableCell>
                    <div className="flex items-center gap-3">
                       <div className="h-8 w-8 rounded bg-pink-500/10 flex items-center justify-center border border-pink-500/20">
                          <Database className="h-4 w-4 text-pink-400" />
                       </div>
                       <div>
                          {dataset.name && (
                            <p className="text-sm font-medium text-white/90">{dataset.name}</p>
                          )}
                          <Link href={`/datasets/${dataset.id}`} className="font-mono text-xs text-muted-foreground hover:underline hover:text-white">
                             {dataset.id.slice(0, 8)}...
                          </Link>
                       </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium text-white/80">
                    {dataset.itemCount.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm">
                    {formatTimeAgo(dataset.modifiedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-8 w-8 hover:bg-white/10 hover:text-indigo-400"
                        title="View"
                        asChild
                      >
                         <Link href={`/datasets/${dataset.id}`}>
                            <Eye className="h-4 w-4" />
                         </Link>
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-8 w-8 hover:bg-white/10 hover:text-emerald-400"
                        title="Download"
                        onClick={() => handleDownload(dataset.id)}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-8 w-8 hover:bg-white/10 hover:text-rose-400"
                        title="Delete"
                        onClick={() => handleDelete(dataset.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="text-center py-20">
            <div className="h-16 w-16 mx-auto mb-4 rounded-full bg-white/5 flex items-center justify-center">
              <Database className="h-8 w-8 text-muted-foreground opacity-50" />
            </div>
            <p className="text-lg font-medium text-white mb-2">{search ? 'No datasets found' : 'No datasets yet'}</p>
            <p className="text-muted-foreground text-sm">Run a scraper to generate data collections.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DatasetsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-10 w-10 animate-spin text-pink-500" />
      </div>
    }>
      <DatasetsContent />
    </Suspense>
  );
}
