'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2, Play } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { prefixPath } from '@/lib/path-prefix';
import { useToast } from '@/components/ui/toast';
import type { Actor } from '@/lib/api';
import { getActors, startRun } from '@/lib/api';

function NewRunContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const preselected = searchParams.get('actor');

  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedActor, setSelectedActor] = useState<string>(preselected || '');

  useEffect(() => {
    let alive = true;
    getActors()
      .then((data) => {
        if (!alive) return;
        setActors(data);
        if (preselected && data.find((a) => a.id === preselected)) {
          setSelectedActor(preselected);
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [preselected]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedActor) return;
    setSubmitting(true);
    try {
      const run = await startRun(selectedActor);
      toast.success('Run started');
      router.push(prefixPath(`/runs/${run.id}`));
    } catch (err) {
      toast.error('Failed to start run', { description: (err as Error).message });
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center min-h-[40vh]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-6">
      <AppLink
        href="/runs"
        className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-muted-foreground hover:text-foreground uppercase"
      >
        <ArrowLeft className="h-3 w-3" /> runs
      </AppLink>

      <header className="space-y-2 pb-5 border-b border-border">
        <p className="eyebrow">EXEC · NEW RUN</p>
        <h1 className="text-[28px] leading-none font-medium tracking-tight">Start a run</h1>
        <p className="text-muted-foreground text-[13px]">
          Pick an actor to execute with its default configuration.
        </p>
      </header>

      <form onSubmit={(e) => void handleSubmit(e)} className="panel p-6 space-y-5">
        <div className="space-y-1.5">
          <label
            htmlFor="actor"
            className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase"
          >
            Actor
          </label>
          <select
            id="actor"
            value={selectedActor}
            onChange={(e) => setSelectedActor(e.target.value)}
            className="w-full h-9 px-3 rounded-sm border border-border bg-input text-[13px] text-foreground focus:outline-none focus:border-signal/50"
            required
          >
            <option value="" disabled>
              select an actor…
            </option>
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.title || actor.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            For custom input or memory/timeout overrides, open the actor and use the launcher.
          </p>
        </div>

        <div className="flex justify-end pt-2 border-t border-border">
          <button
            type="submit"
            disabled={!selectedActor || submitting}
            className="h-9 px-4 inline-flex items-center gap-2 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            execute
          </button>
        </div>
      </form>

      <p className="font-mono text-[10px] tracking-widest text-muted-foreground text-center">
        runs initialize in 30–60s · spinning up container
      </p>
    </div>
  );
}

export default function NewRunPage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center min-h-[40vh]">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <NewRunContent />
    </Suspense>
  );
}
