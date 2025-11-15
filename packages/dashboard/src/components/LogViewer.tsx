"use client";

import { useEffect, useRef, useState } from "react";
import { ScrollText, Play, Pause, Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

interface LogViewerProps {
  runId: string;
  token: string;
}

export function LogViewer({ runId, token }: LogViewerProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    if (!isStreaming) return;
    
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
    const wsUrl = apiUrl.replace('http', 'ws');
    
    const ws = new WebSocket(`${wsUrl}/v2/actor-runs/${runId}/logs/stream?token=${token}`);
    wsRef.current = ws;
    
    ws.onopen = () => {
      setIsConnected(true);
    };
    
    ws.onmessage = (event) => {
      try {
        const log = JSON.parse(event.data);
        if (log.error) {
          console.error('WebSocket error:', log.error);
          return;
        }
        setLogs(prev => [...prev, log]);
        if (autoScrollRef.current && scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      } catch (e) {
        console.error('Failed to parse log:', e);
      }
    };
    
    ws.onclose = () => {
      setIsConnected(false);
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setIsConnected(false);
    };
    
    return () => {
      ws.close();
    };
  }, [runId, token, isStreaming]);

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollTop + clientHeight >= scrollHeight - 50;
  }

  function toggleStreaming() {
    if (isStreaming) {
      wsRef.current?.close();
    }
    setIsStreaming(!isStreaming);
  }

  function clearLogs() {
    setLogs([]);
  }

  function downloadLogs() {
    const content = logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `run-${runId}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function getLevelColor(level: string) {
    switch (level.toUpperCase()) {
      case 'ERROR': return 'text-red-500';
      case 'WARN': return 'text-yellow-500';
      case 'INFO': return 'text-blue-500';
      case 'DEBUG': return 'text-gray-500';
      default: return 'text-foreground';
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-3 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-sm">Logs</span>
          <Badge variant={isConnected ? "success" : "outline"} className="text-xs">
            {isConnected ? "Live" : "Disconnected"}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={toggleStreaming} title={isStreaming ? "Pause" : "Resume"}>
            {isStreaming ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={downloadLogs} title="Download">
            <Download className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={clearLogs} title="Clear">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      
      <div 
        ref={scrollRef} 
        onScroll={handleScroll}
        className="flex-1 overflow-auto bg-zinc-950 font-mono text-xs p-3"
      >
        {logs.length === 0 ? (
          <div className="text-muted-foreground text-center py-8">
            Waiting for logs...
          </div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="flex gap-2 py-0.5 hover:bg-zinc-900/50">
              <span className="text-muted-foreground shrink-0">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span className={`shrink-0 w-12 ${getLevelColor(log.level)}`}>
                [{log.level}]
              </span>
              <span className="text-zinc-100 break-all">
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
