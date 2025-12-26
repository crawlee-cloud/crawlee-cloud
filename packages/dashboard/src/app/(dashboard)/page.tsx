"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Activity, Server, Users, Zap, Loader2, ArrowRight, ExternalLink, Plus } from 'lucide-react';
import Link from 'next/link';
import { getDashboardStats, getRuns, Run } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function Dashboard() {
  const [stats, setStats] = useState({
    totalRuns: 0,
    activeActors: 0,
    totalDatasets: 0,
    successRate: 100,
  });
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const [statsData, runsData] = await Promise.all([
          getDashboardStats(),
          getRuns(),
        ]);
        setStats(statsData);
        setRecentRuns(runsData.slice(0, 5));
      } catch (error) {
        console.error('Failed to load dashboard data:', error);
      } finally {
        setLoading(false);
      }
    }
    
    loadData();
  }, []);

  function formatTimeAgo(dateString: string) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-black/20">
        <Loader2 className="h-10 w-10 animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-linear-to-r from-white to-white/60 bg-clip-text text-transparent">Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-sm">Overview of your scraping operations</p>
        </div>
        <div className="flex gap-3">
          <Link href="/actors/new">
            <Button className="bg-indigo-600 hover:bg-indigo-700 text-white border-0 shadow-lg shadow-indigo-500/20">
              <Plus className="mr-2 h-4 w-4" /> New Actor
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="border-l-4 border-l-indigo-500">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Actors</CardTitle>
            <Activity className="h-4 w-4 text-indigo-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{stats.activeActors}</div>
            <p className="text-xs text-muted-foreground mt-1">Ready for deployment</p>
          </CardContent>
        </Card>
        
        <Card className="border-l-4 border-l-purple-500">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Runs</CardTitle>
            <Zap className="h-4 w-4 text-purple-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{stats.totalRuns}</div>
            <div className="flex items-center text-xs mt-1">
              <span className={cn("font-medium", stats.successRate >= 90 ? "text-emerald-400" : "text-amber-400")}>
                {stats.successRate}% success rate
              </span>
            </div>
          </CardContent>
        </Card>
        
        <Card className="border-l-4 border-l-pink-500">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Datasets</CardTitle>
            <Server className="h-4 w-4 text-pink-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{stats.totalDatasets}</div>
            <p className="text-xs text-muted-foreground mt-1">Stored collections</p>
          </CardContent>
        </Card>
        
        <Card className="border-l-4 border-l-emerald-500">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">System Status</CardTitle>
            <Users className="h-4 w-4 text-emerald-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-400">Healthy</div>
            <div className="flex items-center gap-2 mt-1">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <p className="text-xs text-muted-foreground">Operational</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Recent Activity</CardTitle>
              <CardDescription>Latest execution audits</CardDescription>
            </div>
            <Link href="/runs">
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-white">
                View All <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {recentRuns.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground bg-white/5 rounded-lg border border-dashed border-white/10">
                  No recent activity found.
                </div>
              ) : (
                recentRuns.map((run, i) => (
                  <div key={run.id} className="group flex items-center justify-between p-3 rounded-lg hover:bg-white/5 transition-colors border border-transparent hover:border-white/5">
                    <div className="flex items-center gap-4">
                      <div className={cn(
                        "h-2 w-2 rounded-full",
                        run.status === 'SUCCEEDED' ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : 
                        run.status === 'RUNNING' ? "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)] animate-pulse" : 
                        run.status === 'READY' ? "bg-zinc-500" : "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"
                      )} />
                      <div>
                        <p className="font-medium text-sm text-white/90 group-hover:text-white transition-colors">{run.actId}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <code className="px-1 py-0.5 rounded bg-black/30 text-[10px] font-mono border border-white/5">{run.id.slice(0, 8)}</code>
                          • {formatTimeAgo(run.createdAt)}
                        </p>
                      </div>
                    </div>
                    <Badge variant={
                      run.status === 'SUCCEEDED' ? 'success' : 
                      run.status === 'RUNNING' ? 'secondary' : 
                      run.status === 'READY' ? 'outline' : 'error'
                    } className="capitalize">
                      {run.status.toLowerCase()}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Common management tasks</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Link href="/actors/new" className="block group">
              <div className="flex items-center justify-between p-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-all cursor-pointer">
                <span className="text-sm font-medium text-white/90 group-hover:text-white">New Actor</span>
                <Plus className="h-4 w-4 text-muted-foreground group-hover:text-indigo-400 transition-colors" />
              </div>
            </Link>
            <Link href="/datasets" className="block group">
              <div className="flex items-center justify-between p-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-all cursor-pointer">
                <span className="text-sm font-medium text-white/90 group-hover:text-white">Browse Datasets</span>
                <Server className="h-4 w-4 text-muted-foreground group-hover:text-pink-400 transition-colors" />
              </div>
            </Link>
            <div className="h-px bg-white/5 my-2" />
            <Link href="/docs" className="block group">
              <div className="flex items-center justify-between p-3 rounded-lg border border-transparent hover:bg-white/5 transition-all cursor-pointer">
                <span className="text-sm text-muted-foreground group-hover:text-white">Documentation</span>
                <ExternalLink className="h-4 w-4 text-muted-foreground group-hover:text-white transition-colors" />
              </div>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
