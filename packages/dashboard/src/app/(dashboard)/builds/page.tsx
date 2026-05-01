'use client';

import { useEffect, useMemo, useState } from 'react';
import { GitBranch, GitCommit, Hammer, RotateCw } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { StatusChip } from '@/components/ui/badge';
import { getActors, getBuilds, type Actor, type ActorBuild } from '@/lib/api';
import { cn } from '@/lib/utils';

/*
  Global builds view — fans out across all actors and merges their build
  histories. The API exposes builds per-actor only (GET /v2/acts/:id/builds),
  so this page does the aggregation client-side. Sorted newest first.
*/

type BuildWithActor = ActorBuild & { actorName: string; actorTitle?: string };

export default function BuildsPage() {
  const [builds, setBuilds] = useState<BuildWithActor[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try {
      const acts = await getActors().catch(() => [] as Actor[]);
      setActors(acts);
      // Fan-out: pull builds for every actor in parallel; tolerate per-actor failure.
      const perActor = await Promise.all(
        acts.map(async (a) => {
          try {
            const bs = await getBuilds(a.id);
            return bs.map((b) => ({
              ...b,
              actorName: a.name,
              actorTitle: a.title,
            }));
          } catch {
            return [] as BuildWithActor[];
          }
        })
      );
      // Cap to the 50 most recent across ALL actors. At platform scale
      // (140 scrapers × N versions), the per-actor build tab is the right
      // place to investigate one actor; this page is a "recent activity"
      // health view — what's been deploying lately, what just failed?
      // Operators wanting the full history click through to the actor.
      const all = perActor
        .flat()
        .sort((a, b) => {
          const ta = new Date(a.createdAt).getTime();
          const tb = new Date(b.createdAt).getTime();
          return tb - ta;
        })
        .slice(0, 50);
      setBuilds(all);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const stats = useMemo(() => {
    const succeeded = builds.filter((b) => b.status === 'SUCCEEDED').length;
    const failed = builds.filter((b) => b.status === 'FAILED').length;
    const inFlight = builds.filter((b) => b.status === 'BUILDING' || b.status === 'PENDING').length;
    return { total: builds.length, succeeded, failed, inFlight };
  }, [builds]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6 pb-4 border-b border-border">
        <div>
          <p className="eyebrow mb-2">BUILD · RECENT</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Recent builds</h1>
          <p className="text-muted-foreground mt-2 text-[13px]">
            Last 50 builds across every actor. For full per-actor history, open the actor and switch
            to the Builds tab.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider border border-border hover:border-signal/40 hover:text-signal rounded-sm disabled:opacity-50"
        >
          <RotateCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /> refresh
        </button>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border rounded-md overflow-hidden">
        <Tile label="Total">{stats.total}</Tile>
        <Tile label="Succeeded" tone="signal">
          {stats.succeeded}
        </Tile>
        <Tile
          label="In flight"
          tone={stats.inFlight > 0 ? 'signal' : undefined}
          live={stats.inFlight > 0}
        >
          {stats.inFlight}
        </Tile>
        <Tile label="Failed" tone={stats.failed > 0 ? 'fail' : undefined}>
          {stats.failed}
        </Tile>
      </div>

      <section className="panel">
        {loading ? (
          <div className="grid-bg p-12 text-center">
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              [ LOADING · · · ]
            </p>
          </div>
        ) : actors.length === 0 ? (
          <div className="grid-bg p-16 text-center">
            <Hammer className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              [ NO ACTORS YET ]
            </p>
            <p className="text-[13px] text-muted-foreground mt-2">
              Create an actor first — builds appear once you push.
            </p>
          </div>
        ) : builds.length === 0 ? (
          <div className="grid-bg p-16 text-center">
            <Hammer className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
            <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
              [ NO BUILDS YET ]
            </p>
            <p className="text-[13px] text-muted-foreground mt-2">
              Push an image with <code className="font-mono text-foreground">crc push</code>, or
              queue one from an actor page.
            </p>
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-widest text-muted-foreground uppercase border-b border-border">
                <th className="px-5 py-2 font-normal">Build</th>
                <th className="px-5 py-2 font-normal">Actor</th>
                <th className="px-5 py-2 font-normal">Status</th>
                <th className="px-5 py-2 font-normal">Source</th>
                <th className="px-5 py-2 font-normal">Image</th>
                <th className="px-5 py-2 font-normal text-right">When</th>
              </tr>
            </thead>
            <tbody>
              {builds.slice(0, 100).map((b) => (
                <tr
                  key={b.id}
                  className="border-b border-border/60 last:border-0 hover:bg-secondary/40 align-top"
                >
                  <td className="px-5 py-3">
                    <p className="font-mono text-foreground">{b.id.slice(0, 12)}</p>
                    <p className="font-mono text-[10px] text-muted-foreground tracking-wider mt-1">
                      {b.logCount.toLocaleString()} log lines
                    </p>
                  </td>
                  <td className="px-5 py-3">
                    <AppLink
                      href={`/actors/${b.actorName}`}
                      className="text-foreground hover:text-signal text-[13px]"
                    >
                      {b.actorTitle || b.actorName}
                    </AppLink>
                  </td>
                  <td className="px-5 py-3">
                    <StatusChip status={b.status} />
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px]">
                    {/*
                      Version + tag come first — they're the most
                      operator-relevant identifier ("which 0.1 build is
                      `latest`?"). Git info shows underneath when present.
                    */}
                    {b.versionNumber && (
                      <p className="text-foreground flex items-center gap-1.5">
                        <span>{b.versionNumber}</span>
                        {b.buildTag && (
                          <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 border border-border rounded-sm text-muted-foreground">
                            {b.buildTag}
                          </span>
                        )}
                      </p>
                    )}
                    {b.gitBranch && (
                      <p className="text-muted-foreground flex items-center gap-1.5 mt-0.5">
                        <GitBranch className="h-3 w-3" />
                        {b.gitBranch}
                      </p>
                    )}
                    {b.gitCommit && (
                      <p className="text-muted-foreground flex items-center gap-1.5 mt-0.5">
                        <GitCommit className="h-3 w-3" />
                        {b.gitCommit.slice(0, 9)}
                      </p>
                    )}
                    {!b.versionNumber && !b.gitBranch && !b.gitCommit && (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground max-w-[260px]">
                    {b.imageName ? (
                      <>
                        <p className="text-foreground truncate" title={b.imageName}>
                          {b.imageName}
                        </p>
                        {b.imageDigest && (
                          <p className="truncate" title={b.imageDigest}>
                            {b.imageDigest.slice(0, 18)}…
                          </p>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground tnum text-right">
                    {timeAgo(b.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Tile({
  label,
  children,
  tone,
  live,
}: {
  label: string;
  children: React.ReactNode;
  tone?: 'signal' | 'fail';
  live?: boolean;
}) {
  const toneClass =
    tone === 'signal' ? 'text-signal' : tone === 'fail' ? 'text-fail' : 'text-foreground';
  return (
    <div className="bg-card px-5 py-4">
      <div className="flex items-center justify-between mb-2">
        <span className="eyebrow">{label}</span>
        {live && <span className="live-dot" />}
      </div>
      <div className={cn('text-2xl font-mono tnum tracking-tight leading-none', toneClass)}>
        {children}
      </div>
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
