/**
 * Long-poll support for Apify's `waitForFinish` query parameter.
 *
 * `apify-client` (`_waitForFinish`) loops on GET /actor-runs/:id (and
 * /actor-builds/:id) sending `waitForFinish=<remaining secs>` and only sleeps
 * between requests when the job is *missing* — it relies entirely on the
 * server holding the request open while the job is non-terminal. Answering
 * immediately turns every `client.run(id).waitForFinish()` / `actor.call()`
 * into a tight request loop against the API and the database.
 *
 * Pieces, reusable by every route that accepts `waitForFinish`:
 *   - `waitForTerminal`        — the polling loop (re-reads via `load`).
 *   - `parseWaitForFinish`     — Zod-validates and clamps the query param.
 *   - `createWaitAbortFactory` — per-request AbortSignal that fires on client
 *                                disconnect or server shutdown.
 *   - `markLongPoll` / `isLongPollRequest` — keeps long-polls out of the
 *                                request-duration histogram (mark from
 *                                `waitForTerminal`'s `onWait`).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/** Server-side cap on the `waitForFinish` value, same as Apify's API. */
export const MAX_WAIT_FOR_FINISH_SECS = 60;

/**
 * Hard wall-clock cap on how long `waitForTerminal` holds a request,
 * whatever `waitSecs` says. Kept clearly below 60s because nginx
 * (`proxy_read_timeout`), AWS ALB/ELB and most other reverse proxies default
 * to a 60s idle timeout: a wait clamped to exactly 60s answers at ~60.1s
 * (final load + serialization) and loses that race with a 504. The 5s margin
 * covers the final load and the response. Returning a non-terminal run early
 * is Apify-compatible — apify-client re-polls with its remaining budget.
 */
export const MAX_WAIT_MS = 55_000;

/** Terminal job statuses (`@apify/consts` ACT_JOB_TERMINAL_STATUSES). */
export const TERMINAL_STATUSES: readonly string[] = ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface WaitForTerminalOptions<T> {
  /** Loads the current value. `null` means not found and ends the wait immediately. */
  load: () => Promise<T | null>;
  isTerminal: (value: T) => boolean;
  /** Maximum time to wait, in seconds. 0 = load once and return. */
  waitSecs: number;
  /** Aborting ends the wait with the last loaded value, without another load. */
  signal?: AbortSignal;
  /** Base delay between loads; up to 10% jitter is added so waiters don't align. */
  intervalMs?: number;
  /**
   * Called once, right before the first sleep — i.e. only when the request
   * is actually going to be held open. Routes pass
   * `() => markLongPoll(request)` so answers that return straight away
   * (already terminal, not found, `waitSecs` 0) stay in the latency
   * histogram.
   */
  onWait?: () => void;
  /**
   * Called when a re-load (any load after the first successful one) throws.
   * The wait then ends with the last successfully loaded value instead of
   * failing the whole request; routes pass a `request.log.warn`. An error
   * from the initial load is always rethrown.
   */
  onLoadError?: (err: unknown) => void;
  /** Wall-clock cap overriding `MAX_WAIT_MS` (tests). */
  maxWaitMs?: number;
}

/**
 * Re-loads a value until it is terminal, `waitSecs` (capped at `maxWaitMs`)
 * elapse, or `signal` aborts, and returns the last loaded value. Returns
 * `null` immediately when the first (or any) load finds nothing. A failing
 * re-load ends the wait with the last good value (see `onLoadError`).
 * Sleeping holds no resources besides a timer, so callers should make `load`
 * check out a DB connection per call.
 */
export async function waitForTerminal<T>({
  load,
  isTerminal,
  waitSecs,
  signal,
  intervalMs = 1000,
  onWait,
  onLoadError,
  maxWaitMs = MAX_WAIT_MS,
}: WaitForTerminalOptions<T>): Promise<T | null> {
  const deadline = Date.now() + Math.min(Math.max(0, waitSecs) * 1000, maxWaitMs);
  let waited = false;
  let value = await load();

  for (;;) {
    if (value === null || isTerminal(value) || signal?.aborted) return value;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return value;

    if (!waited) {
      waited = true;
      onWait?.();
    }
    const jitter = Math.random() * intervalMs * 0.1;
    await sleep(Math.min(intervalMs + jitter, remaining), signal);
    if (signal?.aborted) return value;

    try {
      value = await load();
    } catch (err) {
      onLoadError?.(err);
      return value;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `waitForFinish` querystring param: non-negative seconds. Fractional values
 * are floored and values above the cap are clamped (not rejected) —
 * apify-client sends 999999 when the caller set no wait budget. Negative or
 * non-numeric values throw a ZodError (→ 400 `validation_error` via the
 * global error handler).
 */
const WaitForFinishQuerySchema = z.object({
  waitForFinish: z.coerce.number().min(0).optional(),
});

export function parseWaitForFinish(query: unknown): number {
  const { waitForFinish } = WaitForFinishQuerySchema.parse(query ?? {});
  return Math.floor(Math.min(waitForFinish ?? 0, MAX_WAIT_FOR_FINISH_SECS));
}

export interface WaitAbortHandle {
  signal: AbortSignal;
  /** Removes the listeners; call in `finally` once the wait is over. */
  dispose: () => void;
}

/**
 * Call once at plugin registration time; returns a per-request factory for
 * an AbortSignal that fires when the client disconnects or the server starts
 * shutting down.
 *
 * Shutdown uses `preClose`, not `onClose`: Fastify runs user `onClose` hooks
 * only after `server.close()` has drained in-flight requests, so an `onClose`
 * abort would never fire while a long-poll is holding the drain open (the
 * process would sit until SHUTDOWN_TIMEOUT_SECS and force-exit). `preClose`
 * runs before `server.close()`, so pending waits respond with the current
 * state and the drain completes promptly. Those responses also carry
 * `Connection: close`: `server.close()` otherwise keeps waiting on the
 * now-idle keep-alive socket (Fastify only force-closes idle connections
 * with a custom serverFactory), which stalls `app.close()` just the same.
 *
 * Disconnect uses `reply.raw` 'close' + `!writableFinished`. `request.raw`
 * 'close' fires as soon as a bodyless request has been fully read on Node
 * 16+, which would end every wait immediately.
 */
export function createWaitAbortFactory(
  fastify: FastifyInstance
): (reply: FastifyReply) => WaitAbortHandle {
  const shutdown = new AbortController();
  fastify.addHook('preClose', (done) => {
    shutdown.abort();
    done();
  });

  return (reply) => {
    const controller = new AbortController();
    const onShutdown = () => {
      if (!reply.sent) reply.header('connection', 'close');
      controller.abort();
    };
    const onClose = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };

    if (shutdown.signal.aborted) onShutdown();
    shutdown.signal.addEventListener('abort', onShutdown, { once: true });
    reply.raw.on('close', onClose);

    return {
      signal: controller.signal,
      dispose: () => {
        shutdown.signal.removeEventListener('abort', onShutdown);
        reply.raw.off('close', onClose);
      },
    };
  };
}

const LONG_POLL = Symbol('longPoll');

/** Flags a request as a long-poll so duration metrics can skip it. */
export function markLongPoll(request: FastifyRequest): void {
  (request as unknown as Record<symbol, boolean>)[LONG_POLL] = true;
}

export function isLongPollRequest(request: FastifyRequest): boolean {
  return (request as unknown as Record<symbol, boolean>)[LONG_POLL] === true;
}
