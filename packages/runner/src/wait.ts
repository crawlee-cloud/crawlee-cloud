/**
 * Race a promise against a timeout, ALWAYS clearing the timer once either
 * side settles. The previous inline Promise.race in executeRun discarded
 * its setTimeout handle, leaking one live timer per completed run for up
 * to timeoutSecs (default 3600s) — hundreds of pending timers on a busy
 * runner, and a graceful shutdown that waits on them.
 *
 * Lives in its own module (not docker.ts) so importing it — e.g. from
 * tests — doesn't trigger docker.ts's module-level Redis connection.
 */
export async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
