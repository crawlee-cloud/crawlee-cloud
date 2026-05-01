'use client';

import { useState } from 'react';
import { ArrowLeft, Check, Copy, Folder, Package, Sparkles, Terminal } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/*
  "New actor" is documentation, not a form — actor creation happens via `crc push`.
  This page hosts the quickstart commands and a sample manifest.
*/

function CopyButton({ text }: { text: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            toast.success('Copied to clipboard');
            setTimeout(() => setCopied(false), 2000);
          } catch {
            toast.error('Copy failed');
          }
        })();
      }}
      title="Copy"
      className="absolute right-2 top-2 p-1.5 rounded-sm border border-border bg-card text-muted-foreground hover:text-foreground hover:border-signal/40"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-signal" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function CodeBlock({
  caption,
  copyText,
  children,
}: {
  caption?: string;
  copyText: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      {caption && (
        <p className="font-mono text-[10px] tracking-widest text-muted-foreground mb-1 uppercase">
          {caption}
        </p>
      )}
      <pre className="panel bg-background p-4 pr-12 font-mono text-[12px] text-foreground overflow-x-auto leading-relaxed">
        {children}
      </pre>
      <CopyButton text={copyText} />
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-signal tracking-wider tnum">
          [{String(n).padStart(2, '0')}]
        </span>
        <span className="text-[14px] text-foreground">{label}</span>
      </div>
      {children}
    </div>
  );
}

export default function NewActorPage() {
  return (
    <div className="space-y-8 max-w-3xl">
      <AppLink
        href="/actors"
        className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-muted-foreground hover:text-foreground uppercase"
      >
        <ArrowLeft className="h-3 w-3" /> actors
      </AppLink>

      <header className="space-y-2 pb-5 border-b border-border">
        <p className="eyebrow">BUILD · NEW ACTOR</p>
        <h1 className="text-[28px] leading-none font-medium tracking-tight">Create an actor</h1>
        <p className="text-muted-foreground text-[13px]">
          Actor creation is a CLI workflow. Push from any directory and the platform registers it
          for you.
        </p>
      </header>

      {/* Quickstart */}
      <section className="space-y-5">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-signal" />
          <h2 className="text-[15px] text-foreground">Quickstart</h2>
        </div>

        <Step n={1} label="Scaffold from a template">
          <CodeBlock copyText="npx apify-cli create my-actor">
            <span className="text-muted-foreground">$</span> npx apify-cli create{' '}
            <span className="text-info">my-actor</span>
          </CodeBlock>
          <p className="text-[12px] text-muted-foreground pl-1">
            Uses the official Apify CLI — Cheerio, Playwright, Puppeteer templates all work.
          </p>
        </Step>

        <Step n={2} label="Edit the scraper">
          <CodeBlock copyText="cd my-actor && code .">
            <span className="text-muted-foreground">$</span> cd my-actor && code .
          </CodeBlock>
        </Step>

        <Step n={3} label="Push to the platform">
          <CodeBlock copyText="npx crawlee-cloud push">
            <span className="text-muted-foreground">$</span> npx crawlee-cloud push
          </CodeBlock>
          <p className="text-[12px] text-muted-foreground pl-1">
            Builds the Docker image, registers the actor by reading{' '}
            <code className="font-mono text-foreground">.actor/actor.json</code>, pushes to your
            registry.
          </p>
        </Step>
      </section>

      {/* Manifest */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-signal" />
          <h2 className="text-[15px] text-foreground">Actor manifest</h2>
        </div>
        <p className="text-[13px] text-muted-foreground">
          The <code className="font-mono text-foreground">.actor/actor.json</code> file at your repo
          root holds all actor metadata.
        </p>
        <CodeBlock
          caption=".actor/actor.json"
          copyText={`{
  "actorSpecification": 1,
  "name": "my-actor",
  "title": "My Actor",
  "description": "Scrapes data from example.com",
  "version": "1.0.0",
  "dockerfile": "./Dockerfile",
  "defaultRunOptions": {
    "memory": 1024,
    "timeout": 3600
  }
}`}
        >
          {`{
  `}
          <span className="text-info">&quot;actorSpecification&quot;</span>:{' '}
          <span className="text-warn">1</span>,
          {`
  `}
          <span className="text-info">&quot;name&quot;</span>:{' '}
          <span className="text-signal">&quot;my-actor&quot;</span>,
          {`
  `}
          <span className="text-info">&quot;title&quot;</span>:{' '}
          <span className="text-signal">&quot;My Actor&quot;</span>,
          {`
  `}
          <span className="text-info">&quot;version&quot;</span>:{' '}
          <span className="text-signal">&quot;1.0.0&quot;</span>,
          {`
  `}
          <span className="text-info">&quot;dockerfile&quot;</span>:{' '}
          <span className="text-signal">&quot;./Dockerfile&quot;</span>,
          {`
  `}
          <span className="text-info">&quot;defaultRunOptions&quot;</span>:{' '}
          {`{
    `}
          <span className="text-info">&quot;memory&quot;</span>:{' '}
          <span className="text-warn">1024</span>,
          {`
    `}
          <span className="text-info">&quot;timeout&quot;</span>:{' '}
          <span className="text-warn">3600</span>
          {`
  }
}`}
        </CodeBlock>
      </section>

      {/* Existing actor */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Folder className="h-4 w-4 text-signal" />
          <h2 className="text-[15px] text-foreground">Push an existing Apify actor</h2>
        </div>
        <CodeBlock copyText="cd your-existing-actor && npx crawlee-cloud push">
          <span className="text-muted-foreground">$</span> cd{' '}
          <span className="text-info">your-existing-actor</span>
          {`
`}
          <span className="text-muted-foreground">$</span> npx crawlee-cloud push
          {`

`}
          <span className="text-signal">✓</span> reading .actor/actor.json
          {`
`}
          <span className="text-signal">✓</span> building docker image
          {`
`}
          <span className="text-signal">✓</span> registering actor
          {`
`}
          <span className="text-signal">✓</span> done · /actors/your-actor
        </CodeBlock>
      </section>

      {/* Compatibility note */}
      <aside className={cn('panel p-4 flex items-start gap-3 border-l-2 border-l-info')}>
        <Package className="h-4 w-4 text-info mt-0.5 shrink-0" />
        <div>
          <p className="font-mono text-[10px] tracking-widest text-info uppercase mb-1">
            APIFY · COMPATIBILITY
          </p>
          <p className="text-[13px] text-foreground">
            Existing Apify actors run unmodified — point{' '}
            <code className="font-mono">APIFY_API_BASE_URL</code> at this platform and push.
          </p>
        </div>
      </aside>
    </div>
  );
}
