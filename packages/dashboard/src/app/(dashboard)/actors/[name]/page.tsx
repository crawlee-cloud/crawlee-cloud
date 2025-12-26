"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Play, Trash2, Clock, Activity, Loader2, Database, Terminal, Settings, Code, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getActor, getActorRuns, deleteActor, startRun, Actor, Run } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function ActorDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const router = useRouter();
  const [actor, setActor] = useState<Actor | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  
  // Run configuration state
  const [showRunPanel, setShowRunPanel] = useState(false);
  const [inputJson, setInputJson] = useState('{\n  \n}');
  const [timeout, setTimeout] = useState(3600);
  const [memory, setMemory] = useState(1024);
  const [starting, setStarting] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const actorData = await getActor(name);
        setActor(actorData);
        const runsData = await getActorRuns(actorData.id);
        setRuns(runsData);
      } catch (err) {
        console.error('Failed to load actor:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [name]);

  async function handleDelete() {
    if (!actor) return;
    if (!confirm(`Delete actor "${actor.name}"? This cannot be undone.`)) return;
    
    setDeleting(true);
    try {
      await deleteActor(actor.id);
      router.push('/actors');
    } catch (err) {
      console.error('Failed to delete actor:', err);
      setDeleting(false);
    }
  }

  async function handleStartRun() {
    if (!actor) return;
    
    // Validate JSON
    let parsedInput;
    try {
      parsedInput = inputJson.trim() ? JSON.parse(inputJson) : undefined;
      setJsonError(null);
    } catch {
      setJsonError('Invalid JSON format');
      return;
    }
    
    setStarting(true);
    try {
      const run = await startRun(actor.id, {
        input: parsedInput,
        timeout,
        memory,
      });
      router.push(`/runs/${run.id}`);
    } catch (err) {
      console.error('Failed to start run:', err);
      setStarting(false);
    }
  }

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
      case 'RUNNING': return <Badge variant="secondary" className="bg-blue-500/10 text-blue-400 border-blue-500/20">Running</Badge>;
      case 'SUCCEEDED': return <Badge variant="success">Succeeded</Badge>;
      case 'FAILED': return <Badge variant="destructive">Failed</Badge>;
      case 'READY': return <Badge variant="outline">Ready</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  }

  if (loading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-indigo-500" />
      </div>
    );
  }

  if (!actor) {
    return (
      <div className="flex flex-col items-center justify-center py-24 space-y-4">
        <div className="h-12 w-12 rounded-full bg-white/5 flex items-center justify-center">
          <Terminal className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-semibold">Actor not found</h2>
        <Button asChild variant="outline">
          <Link href="/actors">Back to Actors</Link>
        </Button>
      </div>
    );
  }

  const lastRun = runs[0];

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
        <div className="flex items-start gap-4">
          <Button variant="outline" size="icon" asChild className="mt-1 h-9 w-9 bg-white/5 border-white/10 hover:bg-white/10">
            <Link href="/actors">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold tracking-tight text-white">{actor.title || actor.name}</h1>
              <Badge variant="glass" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">Active</Badge>
            </div>
            <p className="text-muted-foreground font-mono text-sm flex items-center gap-2">
              <span className="text-indigo-400">@crawlee/</span>{actor.name}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            variant="ghost" 
            size="icon" 
            className="text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
          <Button 
            onClick={() => setShowRunPanel(!showRunPanel)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/20 border-0"
          >
            <Play className="mr-2 h-4 w-4" />
            Start Run
            {showRunPanel ? <ChevronUp className="ml-2 h-4 w-4" /> : <ChevronDown className="ml-2 h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Run Configuration Panel */}
      {showRunPanel && (
        <Card className="border-indigo-500/30 bg-indigo-950/20 backdrop-blur-xl animate-in slide-in-from-top-2 duration-200">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <Code className="h-5 w-5 text-indigo-400" />
              Run Configuration
            </CardTitle>
            <CardDescription>Configure input and resources for this run</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Input JSON Editor */}
            <div className="space-y-2">
              <Label className="text-white/80 flex items-center gap-2">
                Input (JSON)
                {jsonError && <span className="text-rose-400 text-xs font-normal">{jsonError}</span>}
              </Label>
              <textarea
                value={inputJson}
                onChange={(e) => {
                  setInputJson(e.target.value);
                  setJsonError(null);
                }}
                className={cn(
                  "w-full h-48 px-4 py-3 rounded-lg border bg-black/50 font-mono text-sm text-zinc-300 focus:outline-none focus:ring-2 transition-colors resize-none",
                  jsonError 
                    ? "border-rose-500/50 focus:ring-rose-500/50" 
                    : "border-white/10 focus:ring-indigo-500/50"
                )}
                placeholder='{\n  "url": "https://example.com",\n  "maxItems": 100\n}'
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                Enter JSON input for the actor. Leave empty to run with no input.
              </p>
            </div>

            {/* Resource Settings */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-white/80">Timeout (seconds)</Label>
                <select
                  value={timeout}
                  onChange={(e) => setTimeout(Number(e.target.value))}
                  className="w-full h-10 px-3 rounded-md border border-white/10 bg-black/50 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                >
                  <option value={300}>5 minutes</option>
                  <option value={600}>10 minutes</option>
                  <option value={1800}>30 minutes</option>
                  <option value={3600}>1 hour</option>
                  <option value={7200}>2 hours</option>
                  <option value={14400}>4 hours</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label className="text-white/80">Memory (MB)</Label>
                <select
                  value={memory}
                  onChange={(e) => setMemory(Number(e.target.value))}
                  className="w-full h-10 px-3 rounded-md border border-white/10 bg-black/50 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                >
                  <option value={256}>256 MB</option>
                  <option value={512}>512 MB</option>
                  <option value={1024}>1 GB</option>
                  <option value={2048}>2 GB</option>
                  <option value={4096}>4 GB</option>
                </select>
              </div>
            </div>

            {/* Start Button */}
            <div className="flex justify-end gap-3 pt-2">
              <Button 
                variant="ghost" 
                onClick={() => setShowRunPanel(false)}
                className="text-muted-foreground hover:text-white"
              >
                Cancel
              </Button>
              <Button 
                onClick={handleStartRun}
                disabled={starting}
                className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/20"
              >
                {starting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Start Run
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="bg-white/5 border-white/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="h-4 w-4 text-indigo-400" />
              Total Runs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{runs.length}</div>
          </CardContent>
        </Card>

        <Card className="bg-white/5 border-white/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4 text-purple-400" />
              Last Run
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">
              {lastRun ? formatTimeAgo(lastRun.createdAt) : 'Never'}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white/5 border-white/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Settings className="h-4 w-4 text-pink-400" />
              Build Status
            </CardTitle>
          </CardHeader>
          <CardContent>
             <div className="flex items-center gap-2">
                <div className="text-2xl font-bold text-emerald-400">Valid</div>
                <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
             </div>
          </CardContent>
        </Card>
      </div>

      {/* Description */}
      {actor.description && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">About</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground leading-relaxed">{actor.description}</p>
          </CardContent>
        </Card>
      )}

      {/* Runs Table */}
      <Card>
        <CardHeader>
          <CardTitle>Run History</CardTitle>
          <CardDescription>Recent execution logs and results</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length > 0 ? (
            <div className="rounded-md border border-white/5 overflow-hidden">
              <Table>
                <TableHeader className="bg-white/5">
                  <TableRow className="border-white/5 hover:bg-transparent">
                    <TableHead className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Run ID</TableHead>
                    <TableHead className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Status</TableHead>
                    <TableHead className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Duration</TableHead>
                    <TableHead className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Dataset</TableHead>
                    <TableHead className="text-right text-xs uppercase tracking-wider text-muted-foreground font-semibold">Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.slice(0, 10).map((run) => (
                    <TableRow key={run.id} className="border-white/5 hover:bg-white/5">
                      <TableCell className="font-mono text-sm">
                        <Link href={`/runs/${run.id}`} className="text-indigo-300 hover:text-indigo-400 transition-colors">
                          {run.id.slice(0, 8)}...
                        </Link>
                      </TableCell>
                      <TableCell>{getStatusBadge(run.status)}</TableCell>
                      <TableCell className="text-muted-foreground text-sm font-mono">{formatDuration(run.startedAt, run.finishedAt)}</TableCell>
                      <TableCell>
                        {run.defaultDatasetId ? (
                          <Link 
                            href={`/datasets/${run.defaultDatasetId}`}
                            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-indigo-400 transition-colors"
                          >
                            <Database className="h-3.5 w-3.5" />
                            <span className="font-mono">{run.defaultDatasetId.slice(0, 8)}...</span>
                          </Link>
                        ) : <span className="text-muted-foreground/50">-</span>}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground text-sm">
                        {formatTimeAgo(run.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="h-10 w-10 rounded-full bg-white/5 flex items-center justify-center mb-3">
                <Play className="h-5 w-5 text-muted-foreground opacity-50" />
              </div>
              <p className="text-muted-foreground">No runs have been executed yet.</p>
              <Button 
                size="sm" 
                variant="outline" 
                className="mt-4" 
                onClick={() => setShowRunPanel(true)}
              >
                Start First Run
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
