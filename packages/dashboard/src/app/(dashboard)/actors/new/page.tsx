"use client";

import { ArrowLeft, Terminal, Copy, Check, Folder, Package, Upload, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="absolute right-3 top-3 p-1.5 rounded-md hover:bg-white/10 transition-colors text-muted-foreground hover:text-white"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

function CodeBlock({ children, copyText }: { children: React.ReactNode; copyText?: string }) {
  const textToCopy = copyText ?? (typeof children === 'string' ? children : '');
  
  return (
    <div className="relative">
      <pre className="p-4 pr-12 bg-black/60 border border-white/10 rounded-lg overflow-x-auto text-sm font-mono text-zinc-300">
        {children}
      </pre>
      <CopyButton text={textToCopy} />
    </div>
  );
}

export default function NewActorPage() {
  return (
    <div className="space-y-8 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/actors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Create New Actor</h1>
          <p className="text-muted-foreground">Deploy a web scraper to Crawlee Cloud</p>
        </div>
      </div>

      {/* Quick Start - CLI Push */}
      <Card className="border-indigo-500/30 bg-gradient-to-br from-indigo-500/5 to-transparent">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <Terminal className="h-5 w-5 text-indigo-400" />
            </div>
            <div>
              <CardTitle className="text-xl">Quick Start</CardTitle>
              <CardDescription>Create and push an actor in 3 commands</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Step 1 */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 text-xs font-bold">1</span>
              <h4 className="font-medium text-white/90">Create a new actor from template</h4>
            </div>
            <CodeBlock copyText="npx apify-cli create my-actor">
              <span className="text-zinc-500">$</span> npx apify-cli create <span className="text-amber-400">my-actor</span>
            </CodeBlock>
            <p className="text-xs text-muted-foreground ml-8">
              Uses the official Apify CLI to scaffold from templates (Cheerio, Playwright, Puppeteer, etc.)
            </p>
          </div>

          {/* Step 2 */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 text-xs font-bold">2</span>
              <h4 className="font-medium text-white/90">Write your scraper code</h4>
            </div>
            <CodeBlock copyText="cd my-actor && code .">
              <span className="text-zinc-500">$</span> cd my-actor && code .
            </CodeBlock>
          </div>

          {/* Step 3 */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 text-xs font-bold">3</span>
              <h4 className="font-medium text-white/90">Push to the platform</h4>
            </div>
            <CodeBlock copyText="npx crawlee-cloud push">
              <span className="text-zinc-500">$</span> npx crawlee-cloud push
            </CodeBlock>
            <p className="text-xs text-muted-foreground ml-8">
              Builds Docker image, registers actor automatically (reads from <code className="px-1 py-0.5 bg-white/5 rounded text-zinc-400">.actor/actor.json</code>), and pushes to the platform
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Actor Configuration */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/10 rounded-lg">
              <Sparkles className="h-5 w-5 text-purple-400" />
            </div>
            <div>
              <CardTitle>Actor Configuration</CardTitle>
              <CardDescription>The <code className="text-xs">.actor/actor.json</code> file contains all metadata</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <CodeBlock copyText={`{
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
}`}>
            <span className="text-zinc-500">.actor/actor.json</span>{"\n"}
            {"{"}{"\n"}
            {"  "}<span className="text-cyan-400">"actorSpecification"</span>: <span className="text-amber-400">1</span>,{"\n"}
            {"  "}<span className="text-cyan-400">"name"</span>: <span className="text-green-400">"my-actor"</span>,{"\n"}
            {"  "}<span className="text-cyan-400">"title"</span>: <span className="text-green-400">"My Actor"</span>,{"\n"}
            {"  "}<span className="text-cyan-400">"description"</span>: <span className="text-green-400">"Scrapes data from example.com"</span>,{"\n"}
            {"  "}<span className="text-cyan-400">"version"</span>: <span className="text-green-400">"1.0.0"</span>,{"\n"}
            {"  "}<span className="text-cyan-400">"dockerfile"</span>: <span className="text-green-400">"./Dockerfile"</span>,{"\n"}
            {"  "}<span className="text-cyan-400">"defaultRunOptions"</span>: {"{"}{"\n"}
            {"    "}<span className="text-cyan-400">"memory"</span>: <span className="text-amber-400">1024</span>,{"\n"}
            {"    "}<span className="text-cyan-400">"timeout"</span>: <span className="text-amber-400">3600</span>{"\n"}
            {"  "}{"}"}{"\n"}
            {"}"}
          </CodeBlock>
        </CardContent>
      </Card>

      {/* Push existing project */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-500/10 rounded-lg">
              <Folder className="h-5 w-5 text-green-400" />
            </div>
            <div>
              <CardTitle>Push an existing Apify actor</CardTitle>
              <CardDescription>Already have an Apify actor? Just push it!</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <CodeBlock copyText="cd your-existing-actor && npx crawlee-cloud push">
            <span className="text-zinc-500">$</span> cd <span className="text-amber-400">your-existing-actor</span>{"\n"}
            <span className="text-zinc-500">$</span> npx crawlee-cloud push{"\n"}
            {"\n"}
            <span className="text-green-400">✓</span> Reading .actor/actor.json...{"\n"}
            <span className="text-green-400">✓</span> Building Docker image...{"\n"}
            <span className="text-green-400">✓</span> Registering actor "your-actor"...{"\n"}
            <span className="text-green-400">✓</span> Done! View at http://localhost:3001/actors/your-actor
          </CodeBlock>
        </CardContent>
      </Card>

      {/* Tip */}
      <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
        <div className="flex gap-3">
          <Package className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium text-amber-200">Apify SDK Compatibility</p>
            <p className="text-sm text-amber-200/70">
              Your existing Apify actors work without code changes. The CLI reads your existing <code className="px-1 py-0.5 bg-amber-500/20 rounded text-amber-300 text-xs">.actor/actor.json</code> and handles everything automatically.
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-start">
        <Button variant="outline" asChild>
          <Link href="/actors">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Actors
          </Link>
        </Button>
      </div>
    </div>
  );
}
