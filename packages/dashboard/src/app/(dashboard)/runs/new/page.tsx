"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Play, Loader2, ChevronDown } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { getActors, startRun, Actor } from "@/lib/api";

function NewRunContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedActorId = searchParams.get('actor');
  
  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedActor, setSelectedActor] = useState<string>(preselectedActorId || "");

  useEffect(() => {
    async function loadActors() {
      try {
        const data = await getActors();
        setActors(data);
        if (preselectedActorId && data.find(a => a.id === preselectedActorId)) {
          setSelectedActor(preselectedActorId);
        }
      } catch (err) {
        console.error('Failed to load actors:', err);
      } finally {
        setLoading(false);
      }
    }
    loadActors();
  }, [preselectedActorId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedActor) return;

    setSubmitting(true);
    try {
      await startRun(selectedActor);
      router.push('/runs');
    } catch (err) {
      console.error('Failed to start run:', err);
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" asChild className="h-9 w-9 bg-white/5 border-white/10 hover:bg-white/10">
          <Link href="/runs">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-linear-to-r from-white to-white/60 bg-clip-text text-transparent">Start New Run</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Configure and launch a new scraper instance
          </p>
        </div>
      </div>

      <Card className="border-white/10 bg-black/40 backdrop-blur-xl shadow-2xl">
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>Select an actor to execute</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="actor" className="text-white/80">Actor</Label>
              <div className="relative">
                <select
                  id="actor"
                  value={selectedActor}
                  onChange={(e) => setSelectedActor(e.target.value)}
                  className="w-full h-10 pl-3 pr-10 rounded-md border border-white/10 bg-white/5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50 appearance-none cursor-pointer hover:bg-white/10 transition-colors"
                >
                  <option value="" className="bg-zinc-900 text-muted-foreground" disabled>Select an actor...</option>
                  {actors.map((actor) => (
                    <option key={actor.id} value={actor.id} className="bg-zinc-900 text-white py-2">
                       {actor.title || actor.name}
                    </option>
                  ))}
                </select>
                <div className="absolute right-3 top-2.5 pointer-events-none text-muted-foreground">
                  <ChevronDown className="h-4 w-4" />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">
                The actor will be executed with its default configuration.
              </p>
            </div>

            <div className="pt-4 flex justify-end">
              <Button 
                type="submit" 
                disabled={!selectedActor || submitting}
                className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/20 w-full sm:w-auto"
              >
                {submitting ? (
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
          </form>
        </CardContent>
      </Card>
      
      <div className="text-center">
         <p className="text-xs text-muted-foreground">
            Takes about 30-60 seconds to initialize a new container.
         </p>
      </div>
    </div>
  );
}

export default function NewRunPage() {
  return (
    <Suspense fallback={
      <div className="flex h-[50vh] items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-indigo-500" />
      </div>
    }>
      <NewRunContent />
    </Suspense>
  );
}
