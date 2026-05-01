/*
  Root loading shell. Shown while the root layout's Suspense boundary
  resolves. Operator-style: a centered live-dot and a mono caption.
*/

export default function Loading() {
  return (
    <div className="min-h-screen grid place-items-center">
      <div className="flex items-center gap-3">
        <span className="live-dot" aria-hidden />
        <span className="font-mono text-[11px] tracking-widest text-muted-foreground">
          BOOTING · CONSOLE
        </span>
      </div>
    </div>
  );
}
