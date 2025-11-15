"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, Clock, Terminal, Loader2, Database, Ban, FileJson, FileInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getRun, getRunLogs, getRunInput, getRunDatasetItems, abortRun, type Run } from "@/lib/api";
import { cn } from "@/lib/utils";
import Link from "next/link"; 

type TabType = 'logs' | 'input' | 'output';

function RunDetailContent() {
  const params = useParams();
  const id = params.id as string;
  
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('logs');
  
  // Logs state
  const [logs, setLogs] = useState<{ timestamp: string; level: string; message: string }[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  // Input state - use undefined to indicate "not fetched yet", null for "fetched but empty"
  const [input, setInput] = useState<unknown>(undefined);
  const [inputLoading, setInputLoading] = useState(false);
  
  // Output/Dataset state - use null to indicate "not fetched yet"
  const [datasetItems, setDatasetItems] = useState<unknown[] | null>(null);
  const [datasetLoading, setDatasetLoading] = useState(false);

  // Poll for run status and logs
  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    async function fetchData() {
      try {
        const [runData, logsData] = await Promise.all([
          getRun(id),
          getRunLogs(id, { limit: 1000 })
        ]);
        setRun(runData);
        setLogs(logsData.items || []);
        setLoading(false);

        // Continue polling if running
        if (runData.status === 'RUNNING' || runData.status === 'READY') {
             // Short poll interval for active runs
        } else {
            clearInterval(intervalId);
        }
      } catch (err) {
        console.error("Failed to load run data:", err);
        setLoading(false);
      }
    }

    fetchData();
    intervalId = setInterval(fetchData, 2000); // Poll every 2s

    return () => clearInterval(intervalId);
  }, [id]);

  // Fetch input when tab changes to input (only if not fetched yet)
  useEffect(() => {
    if (activeTab === 'input' && input === undefined && !inputLoading) {
      setInputLoading(true);
      getRunInput(id).then(data => {
        setInput(data ?? null); // Convert undefined/null to null (meaning "fetched but empty")
        setInputLoading(false);
      }).catch(() => {
        setInput(null); // Mark as fetched (with no data)
        setInputLoading(false);
      });
    }
  }, [activeTab, id, input, inputLoading]);

  // Fetch dataset items when tab changes to output (only if not fetched yet)
  useEffect(() => {
    if (activeTab === 'output' && datasetItems === null && !datasetLoading) {
      setDatasetLoading(true);
      getRunDatasetItems(id, { limit: 100 }).then(data => {
        setDatasetItems(data || []); // Empty array means "fetched but empty"
        setDatasetLoading(false);
      }).catch(() => {
        setDatasetItems([]); // Mark as fetched (with no data)
        setDatasetLoading(false);
      });
    }
  }, [activeTab, id, datasetItems, datasetLoading]);

  // Auto-scroll to bottom of logs
  useEffect(() => {
    if (activeTab === 'logs') {
      logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, activeTab]);

  const handleAbort = async () => {
    if (!confirm("Are you sure you want to abort this run?")) return;
    try {
      await abortRun(id);
    } catch (err) {
      console.error("Failed to abort run:", err);
      alert("Failed to abort run");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex flex-col items-center justify-center h-screen space-y-4">
        <p className="text-muted-foreground">Run not found</p>
        <Button variant="outline" asChild>
            <Link href="/runs">Back to Runs</Link>
        </Button>
      </div>
    );
  }

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'SUCCEEDED': return 'success';
      case 'FAILED': return 'destructive';
      case 'RUNNING': return 'default';
      case 'ABORTED': return 'warning';
      default: return 'secondary';
    }
  };

  const badgeVariant = run ? getStatusBadgeVariant(run.status) as "default" | "secondary" | "destructive" | "outline" | "success" | "warning" : "secondary";

  const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
    { id: 'logs', label: 'Logs', icon: <Terminal className="h-4 w-4" /> },
    { id: 'input', label: 'Input', icon: <FileInput className="h-4 w-4" /> },
    { id: 'output', label: 'Output', icon: <Database className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
            <Link href="/runs" className="hover:text-foreground transition-colors flex items-center gap-1">
               <ArrowLeft className="h-3 w-3" /> Runs
            </Link>
            <span>/</span>
            <span className="text-foreground font-medium">{run.id.slice(0,8)}...</span>
          </div>
          <div className="flex items-center gap-3">
             <h1 className="text-3xl font-bold tracking-tight bg-linear-to-r from-white to-white/60 bg-clip-text text-transparent">
               Run Details
             </h1>
             <Badge variant={badgeVariant} className="text-sm px-3 py-1">
               {run.status}
             </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
           {run.status === 'RUNNING' && (
             <Button variant="destructive" size="sm" onClick={handleAbort} className="bg-rose-500/10 text-rose-400 border-rose-500/20 hover:bg-rose-500/20">
               <Ban className="mr-2 h-4 w-4" />
               Abort Run
             </Button>
           )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
         {/* Info Card */}
         <Card className="glass-card md:col-span-1 h-fit">
            <CardHeader className="pb-3">
               <CardTitle className="flex items-center gap-2 text-base">
                  <Clock className="h-4 w-4 text-indigo-400" />
                  Run Info
               </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
               <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Actor ID</p>
                  <p className="font-mono text-xs text-white truncate">{run.actId}</p>
               </div>
               <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Started At</p>
                  <p className="text-xs text-white">{run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'}</p>
               </div>
               <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Finished At</p>
                  <p className="text-xs text-white">{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '-'}</p>
               </div>
               <div className="grid grid-cols-2 gap-2 pt-2 border-t border-white/5">
                  <div>
                     <p className="text-[10px] text-muted-foreground uppercase">Memory</p>
                     <p className="text-xs text-white font-medium">{run.memoryMbytes} MB</p>
                  </div>
                  <div>
                     <p className="text-[10px] text-muted-foreground uppercase">Timeout</p>
                     <p className="text-xs text-white font-medium">{run.timeoutSecs}s</p>
                  </div>
               </div>
            </CardContent>
         </Card>

         {/* Tabbed Content */}
         <Card className="glass-card md:col-span-3 flex flex-col h-[600px] overflow-hidden">
            {/* Tabs Header */}
            <div className="flex border-b border-white/5 bg-white/5">
               {tabs.map(tab => (
                  <button
                     key={tab.id}
                     onClick={() => setActiveTab(tab.id)}
                     className={cn(
                        "flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px",
                        activeTab === tab.id 
                           ? "border-indigo-500 text-white bg-white/5" 
                           : "border-transparent text-muted-foreground hover:text-white hover:bg-white/5"
                     )}
                  >
                     {tab.icon}
                     {tab.label}
                     {tab.id === 'logs' && run.status === 'RUNNING' && (
                        <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                     )}
                  </button>
               ))}
            </div>

            {/* Tab Content */}
            <CardContent className="flex-1 p-0 overflow-hidden relative">
               {/* Logs Tab */}
               {activeTab === 'logs' && (
                  <div className="absolute inset-0 overflow-auto p-4 space-y-1 bg-black/50 font-mono text-xs scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                     {logs.length > 0 ? (
                        logs.map((log, i) => (
                           <div key={i} className="flex gap-2 hover:bg-white/5 px-1 py-0.5 rounded">
                              <span className="text-zinc-500 shrink-0 w-[140px]">{new Date(log.timestamp).toISOString().split('T')[1].slice(0, -1)}</span>
                              <span className={cn(
                                 "shrink-0 w-[60px] font-bold",
                                 log.level === 'INFO' && "text-blue-400",
                                 log.level === 'WARN' && "text-amber-400",
                                 log.level === 'ERROR' && "text-rose-400",
                                 log.level === 'DEBUG' && "text-purple-400"
                              )}>{log.level}</span>
                              <span className="text-zinc-300 break-all whitespace-pre-wrap">{log.message}</span>
                           </div>
                        ))
                     ) : (
                        <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
                           <Terminal className="h-12 w-12 mb-2" />
                           <p>No logs available</p>
                        </div>
                     )}
                     <div ref={logsEndRef} />
                  </div>
               )}

               {/* Input Tab */}
               {activeTab === 'input' && (
                  <div className="absolute inset-0 overflow-auto p-4 bg-black/50">
                     {inputLoading ? (
                        <div className="h-full flex items-center justify-center">
                           <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                     ) : input && Object.keys(input as object).length > 0 ? (
                        <pre className="font-mono text-xs text-zinc-300 whitespace-pre-wrap bg-white/5 p-4 rounded-lg border border-white/5">
                           {JSON.stringify(input, null, 2)}
                        </pre>
                     ) : (
                        <div className="h-full flex flex-col items-center justify-center">
                           <div className="bg-white/5 rounded-2xl p-8 border border-white/10 text-center">
                              <FileInput className="h-12 w-12 mb-3 text-muted-foreground/50 mx-auto" />
                              <p className="text-muted-foreground font-medium mb-1">No Input Data</p>
                              <p className="text-muted-foreground/60 text-sm">This run was started without any input parameters.</p>
                           </div>
                        </div>
                     )}
                  </div>
               )}

               {/* Output Tab */}
               {activeTab === 'output' && (
                  <div className="absolute inset-0 overflow-auto">
                     {datasetLoading || datasetItems === null ? (
                        <div className="h-full flex items-center justify-center">
                           <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                     ) : datasetItems.length > 0 ? (
                        <Table>
                           <TableHeader className="bg-white/5 sticky top-0 z-10 backdrop-blur-md">
                              <TableRow className="hover:bg-transparent border-white/5">
                                 <TableHead className="w-[50px]">#</TableHead>
                                 {Object.keys(datasetItems[0] as object || {}).slice(0, 8).map((key) => (
                                    <TableHead key={key} className="whitespace-nowrap font-medium text-zinc-300 text-xs">
                                       {key}
                                    </TableHead>
                                 ))}
                              </TableRow>
                           </TableHeader>
                           <TableBody>
                              {datasetItems.map((item, idx) => (
                                 <TableRow key={idx} className="border-white/5 hover:bg-white/5 transition-colors group">
                                    <TableCell className="font-mono text-xs text-muted-foreground w-[50px]">
                                       {idx + 1}
                                    </TableCell>
                                    {Object.keys(datasetItems[0] as object || {}).slice(0, 8).map((key) => {
                                       const value = (item as Record<string, unknown>)[key];
                                       return (
                                          <TableCell key={key} className="max-w-[200px] truncate text-xs text-zinc-400 group-hover:text-zinc-200">
                                             {typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}
                                          </TableCell>
                                       );
                                    })}
                                 </TableRow>
                              ))}
                           </TableBody>
                        </Table>
                     ) : (
                        <div className="h-full flex flex-col items-center justify-center p-4">
                           <div className="bg-white/5 rounded-2xl p-8 border border-white/10 text-center">
                              <Database className="h-12 w-12 mb-3 text-muted-foreground/50 mx-auto" />
                              <p className="text-muted-foreground font-medium mb-1">No Output Data</p>
                              <p className="text-muted-foreground/60 text-sm mb-3">
                                 {run.status === 'RUNNING' 
                                    ? 'The run is still in progress. Data will appear here once the actor produces output.'
                                    : 'This run did not produce any output data.'}
                              </p>
                              {run.defaultDatasetId && (
                                 <Link href={`/datasets/${run.defaultDatasetId}`} className="text-indigo-400 hover:underline text-sm">
                                    View Full Dataset →
                                 </Link>
                              )}
                           </div>
                        </div>
                     )}
                  </div>
               )}
            </CardContent>
            
            {/* Footer with dataset link */}
            {activeTab === 'output' && run.defaultDatasetId && datasetItems && datasetItems.length > 0 && (
               <div className="p-2 border-t border-white/5 bg-white/5 text-center">
                  <Link href={`/datasets/${run.defaultDatasetId}`} className="text-xs text-indigo-400 hover:underline">
                     View Full Dataset ({datasetItems.length} items shown) →
                  </Link>
               </div>
            )}
         </Card>
      </div>
    </div>
  );
}

export default function RunDetailPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen"><Loader2 className="h-8 w-8 animate-spin" /></div>}>
      <RunDetailContent />
    </Suspense>
  );
}
