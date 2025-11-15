"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Play, Loader2, Users, Search, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getActors, Actor } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function ActorsPage() {
  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    async function loadActors() {
      try {
        const data = await getActors();
        setActors(data);
      } catch (err) {
        console.error('Failed to load actors:', err);
      } finally {
        setLoading(false);
      }
    }
    loadActors();
  }, []);

  const filteredActors = actors.filter(actor =>
    actor.name.toLowerCase().includes(search.toLowerCase()) ||
    (actor.title && actor.title.toLowerCase().includes(search.toLowerCase()))
  );

  function formatTimeAgo(date: string): string {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-linear-to-r from-white to-white/60 bg-clip-text text-transparent">Actors</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage and deploy your serverless scrapers
          </p>
        </div>
        <Link href="/actors/new">
          <Button className="bg-indigo-600 hover:bg-indigo-700 text-white border-0 shadow-lg shadow-indigo-500/20">
            <Plus className="mr-2 h-4 w-4" /> New Actor
          </Button>
        </Link>
      </div>

      <div className="relative max-w-md w-full">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          placeholder="Search actors..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full h-10 rounded-lg border border-white/10 bg-white/5 pl-10 pr-3 py-1 text-sm text-white shadow-sm transition-all placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500/50 focus-visible:bg-white/10"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-10 w-10 animate-spin text-indigo-500" />
        </div>
      ) : filteredActors.length > 0 ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {filteredActors.map((actor) => (
            <Card key={actor.id} className="group hover:border-indigo-500/30 transition-all duration-300">
              <CardHeader className="relative">
                <div className="flex items-start justify-between">
                  <div className="w-12 h-12 bg-linear-to-br from-indigo-500/20 to-purple-600/20 border border-white/10 rounded-xl flex items-center justify-center text-white font-bold text-lg group-hover:scale-105 transition-transform duration-300">
                    <Terminal className="h-6 w-6 text-indigo-400" />
                  </div>
                  <Badge variant="glass" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">Active</Badge>
                </div>
                <div className="mt-4 space-y-1">
                  <CardTitle>
                    <Link href={`/actors/${actor.name}`} className="hover:text-indigo-400 transition-colors">
                      {actor.title || actor.name}
                    </Link>
                  </CardTitle>
                  <CardDescription className="line-clamp-2 min-h-[40px]">
                    {actor.description || 'No description provided.'}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div className="pt-4 border-t border-white/5 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Updated {formatTimeAgo(actor.modifiedAt || actor.createdAt)}</span>
                  <Link href={`/runs/new?actor=${actor.id}`}>
                    <Button size="sm" variant="outline" className="h-8 bg-transparent hover:bg-white/5 border-white/10 hover:border-indigo-500/30 hover:text-indigo-400 transition-colors">
                      <Play className="h-3 w-3 mr-1.5" /> Run
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 bg-white/5 rounded-xl border border-dashed border-white/10">
          <div className="h-16 w-16 bg-white/5 rounded-full flex items-center justify-center mb-4">
            <Users className="h-8 w-8 text-muted-foreground opacity-50" />
          </div>
          <h3 className="text-lg font-medium text-white mb-1">{search ? 'No actors found' : 'No actors yet'}</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm text-center">
            {search ? 'Try adjusting your search query.' : 'Get started by creating your first scraper Actor.'}
          </p>
          {!search && (
            <Link href="/actors/new">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create Your First Actor
              </Button>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
