"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Play, RotateCw, Loader2, Activity, Database, ArrowRight } from "lucide-react";
import { getRuns, getActors, Run, Actor } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [actors, setActors] = useState<Record<string, Actor>>({});
  const [loading, setLoading] = useState(true);

  async function loadRuns() {
    setLoading(true);
    try {
      const [runsData, actorsData] = await Promise.all([
        getRuns(),
        getActors()
      ]);
      setRuns(runsData);
      // Create lookup map: actorId -> actor
      const actorMap: Record<string, Actor> = {};
      actorsData.forEach(actor => {
        actorMap[actor.id] = actor;
      });
      setActors(actorMap);
    } catch (err) {
      console.error('Failed to load runs:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRuns();
  }, []);

  function formatDuration(startedAt?: string, finishedAt?: string): string {
    if (!startedAt) return '-';
    const start = new Date(startedAt).getTime();
    const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
    const seconds = Math.floor((end - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  function formatTimeAgo(date: string): string {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case 'RUNNING': return <Badge variant="secondary" className="bg-blue-500/10 text-blue-400 border-blue-500/20 shadow-[0_0_10px_rgba(59,130,246,0.2)]">Running</Badge>;
      case 'SUCCEEDED': return <Badge variant="success">Succeeded</Badge>;
      case 'FAILED': return <Badge variant="destructive">Failed</Badge>;
      case 'READY': return <Badge variant="outline">Ready</Badge>;
      case 'ABORTING': return <Badge variant="warning">Aborting</Badge>;
      case 'ABORTED': return <Badge variant="warning">Aborted</Badge>;
      case 'TIMED-OUT': return <Badge variant="destructive">Timed Out</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-linear-to-r from-white to-white/60 bg-clip-text text-transparent">Runs</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Monitor execution history and active tasks
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={loadRuns} disabled={loading} className="bg-white/5 border-white/10 hover:bg-white/10">
            <RotateCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
          <Link href="/runs/new">
            <Button className="bg-indigo-600 hover:bg-indigo-700 text-white border-0 shadow-lg shadow-indigo-500/20">
              <Play className="mr-2 h-4 w-4" /> Start New Run
            </Button>
          </Link>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-black/20 overflow-hidden backdrop-blur-sm">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-10 w-10 animate-spin text-indigo-500" />
          </div>
        ) : runs.length > 0 ? (
          <Table>
            <TableHeader className="bg-white/5">
              <TableRow className="border-white/5 hover:bg-transparent">
                <TableHead className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">Run ID</TableHead>
                <TableHead className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">Actor</TableHead>
                <TableHead className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">Status</TableHead>
                <TableHead className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">Duration</TableHead>
                <TableHead className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">Dataset</TableHead>
                <TableHead className="text-right font-semibold text-muted-foreground text-xs uppercase tracking-wider">Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id} className="border-white/5 hover:bg-white/5 transition-colors">
                  <TableCell className="font-mono text-sm group">
                    <Link href={`/runs/${run.id}`} className="hover:text-indigo-400 transition-colors">
                      <span className="text-indigo-300 shadow-[0_0_10px_rgba(99,102,241,0.1)]">{run.id.slice(0, 8)}</span>
                      <span className="text-muted-foreground/50 text-[10px] ml-1">...{run.id.slice(-4)}</span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    {run.actId ? (
                      <Link href={`/actors/${run.actId}`} className="flex items-center gap-2 group">
                        <span className="font-medium text-white/80 group-hover:text-indigo-400 transition-colors">
                          {actors[run.actId]?.title || actors[run.actId]?.name || run.actId.slice(0, 8) + '...'}
                        </span>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground text-sm italic">Deleted Actor</span>
                    )}
                  </TableCell>
                  <TableCell>{getStatusBadge(run.status)}</TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">{formatDuration(run.startedAt, run.finishedAt)}</TableCell>
                  <TableCell>
                    {run.defaultDatasetId ? (
                      <Link 
                        href={`/runs/${run.id}?tab=output`}
                        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-indigo-400 transition-colors"
                      >
                        <Database className="h-3.5 w-3.5" />
                        <span className="font-mono">{run.defaultDatasetId.slice(0, 8)}...</span>
                      </Link>
                    ) : <span className="text-muted-foreground/30">-</span>}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm">
                    {formatTimeAgo(run.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="text-center py-20">
            <div className="h-16 w-16 mx-auto mb-4 rounded-full bg-white/5 flex items-center justify-center">
              <Activity className="h-8 w-8 text-muted-foreground opacity-50" />
            </div>
            <h3 className="text-lg font-medium text-white mb-2">No runs yet</h3>
            <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
              Start your first scraper run to see execution details and logs here.
            </p>
            <Button asChild className="bg-indigo-600 hover:bg-indigo-700 text-white">
              <Link href="/runs/new">
                <Play className="mr-2 h-4 w-4" />
                Start Your First Run
              </Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
