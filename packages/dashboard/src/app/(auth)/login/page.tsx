'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Loader2, LogIn, ShieldAlert } from 'lucide-react';
import { prefixPath } from '@/lib/path-prefix';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
      const res = await fetch(`${apiUrl}/v2/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Login failed');

      localStorage.setItem('token', data.data.token);
      localStorage.setItem('user', JSON.stringify(data.data.user));
      document.cookie = `token=${data.data.token}; path=/; max-age=${7 * 24 * 60 * 60}`;

      window.location.href = prefixPath('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/*
        Left: brand panel — only shown on lg+ screens.
        Echoes the operator console aesthetic: corner brackets, a faux
        terminal block, mono labels — sells the "this is a developer tool" vibe
        before they even sign in.
      */}
      <div className="hidden lg:flex flex-col justify-between p-10 bg-surface-2 border-r border-border relative overflow-hidden">
        <header className="flex items-center gap-2.5 relative z-10">
          <Image
            src={prefixPath('/logo-icon.svg')}
            alt="Crawlee Cloud"
            width={28}
            height={28}
            priority
          />
          <div className="flex flex-col leading-none">
            <span className="font-mono text-[12px] tracking-widest text-foreground">CRAWLEE</span>
            <span className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground">
              OPERATOR · v0.1
            </span>
          </div>
        </header>

        <div className="relative z-10 max-w-md">
          <p className="eyebrow mb-4">SELF · HOSTED · APIFY · COMPATIBLE</p>
          <h2 className="text-3xl leading-[1.1] tracking-tight text-foreground mb-4">
            Run scrapers on your infrastructure.
          </h2>
          <p className="text-[14px] text-muted-foreground leading-relaxed">
            A drop-in replacement for the Apify platform. Push existing actors, schedule runs,
            browse datasets, and forward events — all from your own cluster.
          </p>

          {/* Faux terminal block — pure aesthetic */}
          <div className="mt-8 panel bg-background font-mono text-[11px] leading-relaxed">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <span className="text-muted-foreground tracking-widest">$ TERMINAL</span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="live-dot" /> ready
              </span>
            </div>
            <pre className="px-3 py-3 text-foreground whitespace-pre">
              <span className="text-signal">$</span> crc push my-scraper{'\n'}
              <span className="text-muted-foreground">→ build queued · sha 4f1e2c0</span>
              {'\n'}
              <span className="text-signal">$</span> crc run my-scraper{'\n'}
              <span className="text-muted-foreground">→ run started · 8a2f1b3c</span>
            </pre>
          </div>
        </div>

        <footer className="relative z-10 font-mono text-[10px] tracking-widest text-muted-foreground">
          MIT · github.com/crawlee-cloud
        </footer>

        {/* Decorative corner brackets — extreme operator vibes */}
        <div
          className="absolute top-6 left-6 w-10 h-10 border-t border-l border-border opacity-50 pointer-events-none"
          aria-hidden
        />
        <div
          className="absolute bottom-6 right-6 w-10 h-10 border-b border-r border-border opacity-50 pointer-events-none"
          aria-hidden
        />
      </div>

      {/* Right: sign-in form */}
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-7">
          {/* Tiny brand on mobile (left panel hidden) */}
          <div className="lg:hidden flex items-center gap-2.5">
            <div className="h-7 w-7 rounded-sm border border-signal/40 bg-signal/10 grid place-items-center">
              <span className="font-mono text-[11px] text-signal">CC</span>
            </div>
            <span className="font-mono text-[12px] tracking-widest text-foreground">
              CRAWLEE · OPERATOR
            </span>
          </div>

          <header>
            <p className="eyebrow mb-2">AUTH · SIGN IN</p>
            <h1 className="text-[26px] leading-tight font-medium tracking-tight text-foreground">
              Sign in to your console
            </h1>
            <p className="text-[13px] text-muted-foreground mt-1.5">
              Use your operator credentials.
            </p>
          </header>

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 p-3 border border-fail/40 bg-fail/5 rounded-sm"
              >
                <ShieldAlert className="h-3.5 w-3.5 text-fail mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-mono text-[10px] tracking-widest text-fail uppercase">
                    AUTH · FAILED
                  </p>
                  <p className="text-[12px] text-foreground mt-0.5 break-words">{error}</p>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="email"
                className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full h-9 px-3 rounded-sm border border-border bg-input text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-signal/50"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="password"
                className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full h-9 px-3 rounded-sm border border-border bg-input text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-signal/50"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 inline-flex items-center justify-center gap-2 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50 transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> authenticating
                </>
              ) : (
                <>
                  <LogIn className="h-3.5 w-3.5" /> sign in
                </>
              )}
            </button>
          </form>

          <p className="font-mono text-[10px] tracking-widest text-muted-foreground text-center pt-4 border-t border-border">
            self-hosted · no account creation here
          </p>
        </div>
      </div>
    </div>
  );
}
