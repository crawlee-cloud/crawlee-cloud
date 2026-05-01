'use client';

import { useEffect, useState } from 'react';
import { Plus, Search, Drama } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import type { Actor } from '@/lib/api';
import { getActors } from '@/lib/api';

export default function ActorsPage() {
  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let alive = true;
    getActors()
      .then((d) => alive && setActors(d))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? actors.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          (a.title?.toLowerCase().includes(q) ?? false) ||
          (a.description?.toLowerCase().includes(q) ?? false)
      )
    : actors;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6 pb-4 border-b border-border">
        <div>
          <p className="eyebrow mb-2">BUILD · ACTORS</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Actors</h1>
          <p className="text-muted-foreground mt-2 text-[13px]">
            Deploy and manage your serverless scrapers.
          </p>
        </div>
        <AppLink
          href="/actors/new"
          className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm"
        >
          <Plus className="h-3.5 w-3.5" /> new actor
        </AppLink>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search actors"
          className="w-full h-9 pl-9 pr-3 rounded-sm border border-border bg-background text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-signal/50"
        />
      </div>

      {loading ? (
        <div className="panel grid-bg p-12 text-center">
          <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
            [ LOADING · · · ]
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="panel grid-bg p-16 text-center">
          <Drama className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
          <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
            {search ? '[ NO MATCH ]' : '[ NO ACTORS YET ]'}
          </p>
          <p className="text-[13px] text-muted-foreground mt-2">
            {search ? 'Try a different query.' : 'Create your first actor to get started.'}
          </p>
          {!search && (
            <AppLink
              href="/actors/new"
              className="mt-5 h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background rounded-sm"
            >
              <Plus className="h-3.5 w-3.5" /> create actor
            </AppLink>
          )}
        </div>
      ) : (
        <ul className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((a) => (
            <li key={a.id}>
              <AppLink
                href={`/actors/${a.name}`}
                className="block panel p-5 hover:border-signal/40 transition-colors group h-full"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="h-9 w-9 rounded-sm border border-border bg-secondary/60 grid place-items-center text-muted-foreground group-hover:text-signal group-hover:border-signal/40 transition-colors">
                    <Drama className="h-4 w-4" />
                  </div>
                  <span className="font-mono text-[10px] tracking-widest text-muted-foreground border border-border px-1.5 py-0.5 rounded-sm">
                    {a.id.slice(0, 8)}
                  </span>
                </div>
                <h3 className="text-[15px] leading-tight text-foreground group-hover:text-signal transition-colors">
                  {a.title || a.name}
                </h3>
                <p className="font-mono text-[11px] text-muted-foreground mt-1">
                  <span className="text-signal">@crawlee/</span>
                  {a.name}
                </p>
                {a.description && (
                  <p className="text-[12px] text-muted-foreground mt-3 line-clamp-2">
                    {a.description}
                  </p>
                )}
                <div className="mt-4 pt-3 border-t border-border font-mono text-[10px] text-muted-foreground tracking-wider">
                  modified · {timeAgo(a.modifiedAt || a.createdAt)}
                </div>
              </AppLink>
            </li>
          ))}
        </ul>
      )}
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
