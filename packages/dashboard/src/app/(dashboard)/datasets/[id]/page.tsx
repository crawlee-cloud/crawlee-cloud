"use client";

import { useEffect, useState, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, FileJson, Loader2, Trash2, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDataset, getDatasetItems, deleteDataset, type Dataset } from "@/lib/api";
import Link from "next/link"; // Correct import for Link

function DatasetDetailContent() {
  const params = useParams();
  const searchParams = useSearchParams(); // Use useSearchParams for query params
  const router = useRouter();
  const id = params.id as string;
  const pageParam = searchParams.get("page");
  const limitParam = searchParams.get("limit");

  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [totalItems, setTotalItems] = useState(0);

  // Pagination state
  const page = pageParam ? parseInt(pageParam, 10) : 1;
  const limit = limitParam ? parseInt(limitParam, 10) : 50;

  useEffect(() => {
    async function fetchDataset() {
      try {
        const data = await getDataset(id);
        setDataset(data);
        setTotalItems(data.itemCount);
      } catch (err) {
        console.error("Failed to load dataset:", err);
        // Handle error (e.g., redirect or show error)
      } finally {
        setLoading(false);
      }
    }
    fetchDataset();
  }, [id]);

  useEffect(() => {
    async function fetchItems() {
        setItemsLoading(true);
      try {
        const offset = (page - 1) * limit;
        const data = await getDatasetItems(id, { offset, limit });
        setItems(data);
      } catch (err) {
        console.error("Failed to load items:", err);
      } finally {
        setItemsLoading(false);
      }
    }
    if (dataset) { // Only fetch items once dataset info is loaded to confirm existence/count
        fetchItems();
    }
  }, [id, page, limit, dataset]);


  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this dataset? This action cannot be undone.")) return;
    try {
      await deleteDataset(id);
      router.push("/datasets");
    } catch (err) {
      console.error("Failed to delete dataset:", err);
      alert("Failed to delete dataset");
    }
  };

  const handleDownload = () => {
    const jsonString = JSON.stringify(items, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dataset-${id}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const updatePage = (newPage: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", newPage.toString());
    router.push(`?${params.toString()}`);
  };

  if (loading) {
    return (
      <div className="flex h-64 w-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <p className="text-muted-foreground">Dataset not found</p>
        <Button variant="outline" asChild>
            <Link href="/datasets">Back to Datasets</Link>
        </Button>
      </div>
    );
  }

  const totalPages = Math.ceil(totalItems / limit);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
            <Link href="/datasets" className="hover:text-foreground transition-colors flex items-center gap-1">
               <ArrowLeft className="h-3 w-3" /> Datasets
            </Link>
            <span>/</span>
            <span className="text-foreground font-medium truncate max-w-[200px]">{dataset.name || dataset.id}</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight bg-linear-to-r from-white to-white/60 bg-clip-text text-transparent break-all">
            {dataset.name || "Untitled Dataset"}
          </h1>
          <p className="text-muted-foreground text-sm font-mono">
             ID: {dataset.id}
          </p>
        </div>
        <div className="flex items-center gap-2">
           <Button variant="outline" size="sm" onClick={handleDownload} className="glass-button">
            <Download className="mr-2 h-4 w-4" />
            Export JSON
          </Button>
          <Button variant="destructive" size="sm" onClick={handleDelete} className="bg-red-500/10 text-red-400 hover:bg-red-500/20 border-red-500/20">
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
         <Card className="glass-card">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total Items</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold">{dataset.itemCount.toLocaleString()}</div>
            </CardContent>
         </Card>
         <Card className="glass-card">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Created</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold text-base">{new Date(dataset.createdAt).toLocaleString()}</div>
            </CardContent>
         </Card>
          <Card className="glass-card">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Last Modified</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold text-base">{new Date(dataset.modifiedAt).toLocaleString()}</div>
            </CardContent>
         </Card>
      </div>

      {/* Data Viewer */}
      <Card className="glass-card overflow-hidden flex flex-col">
        <div className="p-4 border-b border-white/5 flex items-center justify-between">
            <div className="font-semibold flex items-center gap-2">
                <FileJson className="h-4 w-4 text-indigo-400" />
                Data Preview
            </div>
             <div className="flex items-center gap-2">
                 <Button
                    variant="outline"
                    size="icon"
                    onClick={() => updatePage(page - 1)}
                    disabled={page <= 1 || itemsLoading}
                    className="h-8 w-8"
                 >
                    <ChevronLeft className="h-4 w-4" />
                 </Button>
                 <span className="text-sm text-muted-foreground min-w-[100px] text-center">
                    Page {page} of {totalPages || 1}
                 </span>
                 <Button
                    variant="outline"
                    size="icon"
                    onClick={() => updatePage(page + 1)}
                    disabled={page >= totalPages || itemsLoading}
                    className="h-8 w-8"
                 >
                    <ChevronRight className="h-4 w-4" />
                 </Button>
            </div>
        </div>

        <div className="relative min-h-[400px]">
            {itemsLoading ? (
                 <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-sm z-10">
                    <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
                 </div>
            ) : null}
            
            <div className="overflow-auto max-h-[600px] p-0">
                {items.length > 0 ? (
                    <Table>
                        <TableHeader className="bg-white/5 sticky top-0 z-10 backdrop-blur-md">
                            <TableRow className="hover:bg-transparent border-white/5">
                                <TableHead className="w-[50px]">#</TableHead>
                                {/* Generate headers dynamically from the first item keys */}
                                {Object.keys(items[0] || {}).slice(0, 10).map((key) => (
                                    <TableHead key={key} className="whitespace-nowrap font-medium text-zinc-300">
                                        {key}
                                    </TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {items.map((item, idx) => (
                                <TableRow key={idx} className="border-white/5 hover:bg-white/5 transition-colors group">
                                    <TableCell className="font-mono text-xs text-muted-foreground w-[50px]">
                                        {(page - 1) * limit + idx + 1}
                                    </TableCell>
                                    {Object.keys(items[0] || {}).slice(0, 10).map((key) => {
                                        const value = item[key];
                                        return (
                                            <TableCell key={key} className="max-w-[200px] truncate text-xs text-zinc-400 group-hover:text-zinc-200">
                                                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                            </TableCell>
                                        );
                                    })}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : (
                     <div className="flex flex-col items-center justify-center h-[400px] text-muted-foreground animate-in fade-in">
                        <Database className="h-12 w-12 mb-4 opacity-20" />
                        <p>No items found in this dataset.</p>
                    </div>
                )}
            </div>
        </div>
        <div className="p-2 border-t border-white/5 bg-white/5 text-xs text-center text-muted-foreground">
            Showing {(page - 1) * limit + 1} - {Math.min(page * limit, totalItems)} of {totalItems} items
        </div>
      </Card>
    </div>
  );
}

export default function DatasetDetailPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen"><Loader2 className="h-8 w-8 animate-spin" /></div>}>
      <DatasetDetailContent />
    </Suspense>
  );
}
