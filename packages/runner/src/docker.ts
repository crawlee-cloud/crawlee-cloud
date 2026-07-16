/**
 * Docker container executor.
 *
 * This module handles:
 * - Pulling Actor images
 * - Creating containers with proper environment variables
 * - Starting and monitoring containers
 * - Collecting logs and exit codes
 */

import os from 'node:os';
import Docker from 'dockerode';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { waitWithTimeout } from './wait.js';

let warnedAboutDarwinTranslate = false;

/**
 * Rewrite `localhost` / `127.0.0.1` hosts to `host.docker.internal` when the
 * runner is on macOS. Reason: when the runner runs on the host (typical local
 * dev) and spawns an actor container, `localhost` inside the actor resolves
 * to the actor container itself, not the API on the host. Docker Desktop on
 * macOS provides `host.docker.internal` for this exact case.
 *
 * Linux runners are *not* translated — `host.docker.internal` doesn't resolve
 * by default there, and production Linux deploys typically use a reachable
 * service hostname (compose service name, k8s service, etc.) rather than
 * localhost. Touching the URL on Linux would break those setups.
 *
 * Exported for unit testing — `platform` is parameterised so tests don't have
 * to monkey-patch `os.platform()`.
 */
export function translateLocalhostForContainer(
  url: string,
  platform: string = os.platform()
): string {
  if (platform !== 'darwin') return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      u.hostname = 'host.docker.internal';
      if (!warnedAboutDarwinTranslate) {
        // process.stderr.write flushes synchronously when stderr is a file
        // (the long-running runner case under `npm run start > log 2>&1`),
        // unlike console.warn which line-buffers and only drains at exit.
        // Operators triaging a stuck dev setup need to see this warning live.
        process.stderr.write(
          `[Runner] Rewriting actor APIFY_API_BASE_URL host -> host.docker.internal ` +
            `(macOS dev convenience). Set API_BASE_URL explicitly to silence this.\n`
        );
        warnedAboutDarwinTranslate = true;
      }
      return u.toString().replace(/\/$/, '');
    }
  } catch {
    // If apiBaseUrl isn't a valid URL, leave it alone — caller will error.
  }
  return url;
}

export interface RunOptions {
  runId: string;
  actorId: string;
  image: string;

  // Environment variables to inject (Apify-compatible)
  env: Record<string, string>;

  // Resource limits
  memoryMb?: number;
  timeoutSecs?: number;

  /**
   * Polled after the image pull, before the container is created. Covers
   * the abort-during-pull window: run:abort → stopRun finds no container
   * (it doesn't exist yet) → without this check the container would start
   * anyway and run to natural exit or timeout, pinning the runner busy.
   */
  isAborted?: () => boolean;
}

export interface RunResult {
  exitCode: number;
  startedAt: Date;
  finishedAt: Date;
  /**
   * True when Docker reports `State.OOMKilled` for the finished container.
   * The exit code alone can't distinguish OOM: the kernel's OOM killer
   * produces 137, but so does `docker stop`; and when it SIGKILLs a child
   * process instead of PID 1, the container exits 1 like any crash.
   */
  oomKilled: boolean;
  /**
   * Peak observed working-set memory in MB, sampled every 15s from the
   * Docker stats API while the container ran. Null = unmeasured (run
   * shorter than one tick, aborted before start, or stats failures).
   * Persisted to runs.peak_memory_mb — the basis for per-actor memory
   * right-sizing.
   */
  peakMemoryMb: number | null;
}

const docker = new Docker({
  socketPath: config.dockerSocketPath,
});

// Redis for log streaming
const redis = new Redis(config.redisUrl);

/**
 * Minimal Redis surface the log writer needs — lets tests inject a mock
 * without a live server. Pipeline-shaped (PR #57 review): the writer
 * issues one round-trip per BATCH instead of four per line, which is
 * what caps flush throughput (and thus the boundedFlush backlog) under
 * chatty actors. Matches ioredis' ChainableCommander structurally.
 */
export interface LogRedisPipeline {
  rpush(key: string, value: string): unknown;
  ltrim(key: string, start: number, stop: number): unknown;
  expire(key: string, seconds: number): unknown;
  publish(channel: string, message: string): unknown;
  exec(): Promise<Array<[error: Error | null, result: unknown]> | null>;
}
export interface LogRedis {
  pipeline(): LogRedisPipeline;
}

/**
 * Serialized, error-tolerant writer for a run's streamed log lines.
 *
 * Replaces the previous fire-and-forget async closures (one per Docker
 * 'data' event), which had two prod-observed failure modes: overlapping
 * closures interleaved their rpushes so lines landed out of order, and a
 * rejected Redis command (ioredis flushes pending commands with
 * MaxRetriesPerRequestError after 20 reconnect attempts) became an
 * unhandled rejection — fatal on Node 20 — killing the runner and
 * orphaning every container it supervised. Dropping the batch with a
 * warning is the correct degraded mode: a log line is never worth the
 * process.
 *
 * Exported for unit tests.
 */
export function createLogLineWriter(
  client: LogRedis,
  runId: string
): { enqueue: (entries: string[]) => void; drain: () => Promise<void> } {
  const key = `logs:${runId}`;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (entries: string[]): void => {
    if (entries.length === 0) return;
    chain = chain
      .then(async () => {
        // One pipelined round-trip per batch (PR #57 review) instead of
        // four awaited commands per LINE: per-entry rpush+publish keep
        // list order and subscriber order intact, while ltrim/expire are
        // cap/TTL maintenance that only need to run once per batch (the
        // list transiently exceeds the cap by at most the batch size,
        // trimmed in the same round-trip; the first batch still sets the
        // TTL, preserving the no-immortal-key invariant).
        const pipe = client.pipeline();
        for (const entry of entries) {
          pipe.rpush(key, entry);
          pipe.publish(key, entry);
        }
        pipe.ltrim(key, -1000, -1);
        pipe.expire(key, 86400);
        const results = await pipe.exec();
        // ioredis exec() only rejects on connection-level failures;
        // per-command errors come back in the result tuples and a null
        // result means the pipeline was discarded. Surface both so the
        // batch takes the drop-warning path instead of vanishing quietly.
        if (results === null) throw new Error('pipeline discarded (connection lost)');
        const firstErr = results.find(([err]) => err !== null)?.[0];
        if (firstErr) throw firstErr;
      })
      .catch((err: unknown) => {
        console.warn(
          `[${runId}] Dropped ${String(entries.length)} log line(s) — Redis write failed: ${(err as Error).message}`
        );
      });
  };

  // Resolves once everything enqueued SO FAR has been written or dropped.
  const drain = (): Promise<void> => chain;

  return { enqueue, drain };
}

/**
 * Best-effort single write for lifecycle markers (start / pull / abort /
 * timeout / finish / failure-cause). Logging must never decide a run's
 * fate: these sit on the executeRun/processRun spine, where an unguarded
 * Redis rejection would flip a healthy run FAILED with a Redis error as
 * its status message. Sets the same 24h TTL as the streamed lines so a
 * terminal marker also refreshes the autopsy window; deliberately no
 * ltrim — the finish marker must survive the 1000-line cap.
 */
export async function writeLifecycleLog(
  runId: string,
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string
): Promise<void> {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, message });
  try {
    await redis.rpush(`logs:${runId}`, entry);
    await redis.expire(`logs:${runId}`, 86400);
  } catch (err) {
    console.warn(`[${runId}] Lifecycle log write failed: ${(err as Error).message}`);
  }
}

/**
 * Stream container logs to Redis in real-time.
 *
 * Returns a bounded flush handle: it resolves once the attach stream has
 * ended AND all enqueued writes have landed, or after `timeoutMs` —
 * whichever comes first. executeRun awaits it before writing the finish
 * marker so "Container finished ..." actually lands after the container's
 * final output; the bound guarantees a wedged attach stream can never
 * stall run terminalization.
 */
async function streamLogs(
  container: Docker.Container,
  runId: string
): Promise<(timeoutMs: number) => Promise<void>> {
  const logStream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  const writer = createLogLineWriter(redis, runId);
  let buffer = '';
  let markEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });

  const toEntry = (cleanLine: string): string =>
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: cleanLine.toLowerCase().includes('error')
        ? 'ERROR'
        : cleanLine.toLowerCase().includes('warn')
          ? 'WARN'
          : 'INFO',
      message: cleanLine,
    });

  logStream.on('data', (chunk: Buffer) => {
    // Parsing stays synchronous so `buffer` is never mutated concurrently;
    // only the Redis writes go through the serialized chain.
    // Docker multiplexes stdout/stderr, first 8 bytes are header
    // For simplicity, we'll just process the raw output
    const text = chunk.toString('utf-8');
    buffer += text;

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

    const entries: string[] = [];
    for (const line of lines) {
      if (line.trim()) {
        // Clean Docker multiplex header if present (first 8 bytes per frame)
        // eslint-disable-next-line no-control-regex
        const cleanLine = line.replace(/^[\x00-\x08]/g, '').trim();
        if (cleanLine) entries.push(toEntry(cleanLine));
      }
    }
    writer.enqueue(entries);
  });

  // Flush remaining buffer on end
  logStream.on('end', () => {
    if (buffer.trim()) {
      writer.enqueue([toEntry(buffer.trim())]);
      buffer = '';
    }
    markEnded();
  });
  // The attach socket can error (daemon restart, connection reset); treat
  // it as end-of-stream, flushing the buffered partial line first — a
  // crashing actor's final diagnostic is often written without a trailing
  // newline, and after 'error' no 'end' fires to flush it. Idempotent with
  // 'end' via the trim guard + buffer reset.
  logStream.on('error', (err: Error) => {
    console.warn(`[${runId}] Log stream error: ${err.message}`);
    if (buffer.trim()) {
      writer.enqueue([toEntry(buffer.trim())]);
      buffer = '';
    }
    markEnded();
  });

  return (timeoutMs: number) => boundedFlush(ended, () => writer.drain(), timeoutMs);
}

/**
 * Resolve on (ended AND drained) or after timeoutMs — whichever comes
 * first. The bound must cover BOTH waits: a wedged attach stream ('end'
 * never fires) and a Redis-outage backlog (drain never settles — ioredis
 * has no command timeout, and a black-holed connection can hold the write
 * chain open indefinitely) must be equally unable to stall run
 * terminalization. Abandoning the drain at the deadline is safe: every
 * chain link ends in .catch, so late writes land or drop quietly in the
 * background. Exported for unit tests.
 */
export function boundedFlush(
  ended: Promise<void>,
  drain: () => Promise<void>,
  timeoutMs: number
): Promise<void> {
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    t.unref();
  });
  return Promise.race([ended.then(drain), timeout]);
}

/** How often executeRun samples container memory for peak tracking. */
const STATS_SAMPLE_INTERVAL_MS = 15_000;

/**
 * Working-set memory in MB from a Docker stats snapshot, or null when the
 * frame is malformed. Mirrors what `docker stats` displays: usage minus
 * reclaimable page cache — `inactive_file` on cgroup v2 hosts,
 * `total_inactive_file` on v1 — because raw `usage` includes file cache
 * the kernel would reclaim under pressure and wildly overstates a
 * scraper's real footprint. Exported for unit tests.
 */
export function memoryUsageMbFromStats(stats: unknown): number | null {
  const mem = (stats as { memory_stats?: { usage?: unknown; stats?: Record<string, unknown> } })
    ?.memory_stats;
  if (!mem || typeof mem.usage !== 'number' || !Number.isFinite(mem.usage)) return null;
  // v1-first (total_inactive_file), matching Docker's own
  // calculateMemUsageUnixNoCache: on cgroup v1 BOTH keys exist and the
  // leaf-only inactive_file misses child cgroups' cache; v2 hosts only
  // have inactive_file, so the fallthrough is safe.
  const inactiveRaw = mem.stats?.['total_inactive_file'] ?? mem.stats?.['inactive_file'];
  const inactive =
    typeof inactiveRaw === 'number' && Number.isFinite(inactiveRaw) ? inactiveRaw : 0;
  return Math.max(0, Math.round((mem.usage - inactive) / (1024 * 1024)));
}

/**
 * Cap a run's container memory limit at what the host can actually honor.
 *
 * A cgroup limit >= physical RAM is unenforceable: the kernel OOM killer
 * fires at HOST exhaustion instead of the container's limit, and picks its
 * own victim — sometimes the actor container (clean FAILED), sometimes
 * dockerd or the runner itself (wedged droplet, dead heartbeat, zombie
 * runs — both observed in prod 2026-07-16, retailmenot at 4096MB on
 * 3912MB hosts). Clamping converts "host OOM roulette" into a normal
 * container OOM at a limit the kernel can enforce. The 256MB floor keeps
 * a misconfigured reserve (>= total RAM) from producing an unusable cap.
 *
 * Exported for unit tests and for queue.ts (the claim gate and
 * APIFY_MEMORY_MBYTES must use the same effective value).
 */
export function clampMemoryToHost(
  requestedMb: number,
  hostTotalMb: number,
  reserveMb: number
): number {
  const usable = Math.max(256, hostTotalMb - reserveMb);
  return Math.min(requestedMb, usable);
}

/**
 * Execute an Actor in a Docker container.
 */
export async function executeRun(options: RunOptions): Promise<RunResult> {
  const { runId, actorId, image, env, timeoutSecs = config.defaultTimeoutSecs } = options;

  // Defensive re-clamp: queue.ts already clamps before building the actor
  // env, but this is the single point where the limit reaches Docker, so
  // enforce the invariant here too (idempotent when already clamped).
  const requestedMb = options.memoryMb ?? config.defaultMemoryMb;
  const memoryMb = clampMemoryToHost(requestedMb, config.hostTotalMemoryMb, config.memoryReserveMb);

  console.log(`[${runId}] Starting container for Actor ${actorId}`);
  console.log(`[${runId}] Image: ${image}`);

  // Log start message to Redis
  await writeLifecycleLog(runId, 'INFO', `Starting Actor ${actorId} with image ${image}`);
  if (memoryMb < requestedMb) {
    await writeLifecycleLog(
      runId,
      'WARN',
      `Requested memory ${String(requestedMb)}MB exceeds host capacity; limit clamped to ${String(memoryMb)}MB`
    );
  }

  const startedAt = new Date();

  // Build environment variables array
  const envArray = Object.entries(env).map(([key, value]) => `${key}=${value}`);

  // Pull image if not exists
  try {
    await pullImageIfNeeded(image, runId, options.isAborted);
  } catch (err) {
    console.error(`[${runId}] Failed to pull image:`, err);
    await writeLifecycleLog(runId, 'ERROR', `Failed to pull image: ${String(err)}`);
    throw err;
  }

  // Abort may have landed during the pull, when there was no container
  // for stopRun to stop. Bail before creating one — the run's status is
  // already terminal (ABORTED) in the DB; processRun's guarded UPDATE
  // no-ops and fires the ACTOR.RUN.ABORTED webhook from the re-read.
  if (options.isAborted?.()) {
    console.log(`[${runId}] Run aborted during image pull — not starting container`);
    await writeLifecycleLog(runId, 'WARN', 'Run aborted before container start');
    return {
      exitCode: 137,
      startedAt,
      finishedAt: new Date(),
      oomKilled: false,
      peakMemoryMb: null,
    };
  }

  // Create container
  const container = await docker.createContainer({
    Image: image,
    Env: envArray,
    HostConfig: {
      Memory: memoryMb * 1024 * 1024,
      MemorySwap: memoryMb * 1024 * 1024 * 2,
      NetworkMode: config.dockerNetwork,
      AutoRemove: false, // We'll remove after collecting logs
    },
    Labels: {
      'crawlee-cloud.run-id': runId,
      'crawlee-cloud.actor-id': actorId,
    },
  });

  console.log(`[${runId}] Container created: ${container.id}`);

  // Recheck after creation: an abort landing between the pre-create check
  // and start() would otherwise slip through — at that moment the abort
  // handler's stopRun can only act on the container if it exists, and the
  // container must never start. Remove the created-but-unstarted container
  // and bail. (stopRun also lists with all:true for the same reason — the
  // two sides close the window from both ends.)
  if (options.isAborted?.()) {
    console.log(`[${runId}] Run aborted after container create — removing without start`);
    await container.remove({ force: true }).catch(() => {});
    await writeLifecycleLog(runId, 'WARN', 'Run aborted before container start');
    return {
      exitCode: 137,
      startedAt,
      finishedAt: new Date(),
      oomKilled: false,
      peakMemoryMb: null,
    };
  }

  // Start streaming logs BEFORE starting container
  const flushLogs = await streamLogs(container, runId);

  // Start container
  await container.start();
  console.log(`[${runId}] Container started`);

  // Peak working-set sampling for per-actor right-sizing: memory_mbytes
  // limits are operator guesses (2026-07-16: poulpeo OOMed at 1024 AND
  // 2048 while radins reserved 2048 and co-ran fine), and recorded
  // actuals turn sizing — and any future reservation/overcommit packing —
  // into a data question. Best-effort by design: a missed sample only
  // means a slightly-low peak. The void-async + inner catch shape keeps
  // a stats rejection from ever becoming an unhandled rejection (the
  // crash-bomb class), and unref keeps the timer from pinning shutdown.
  let peakMemoryMb: number | null = null;
  const statsTimer = setInterval(() => {
    void (async () => {
      try {
        const stats: unknown = await container.stats({ stream: false });
        const usedMb = memoryUsageMbFromStats(stats);
        if (usedMb !== null && usedMb > (peakMemoryMb ?? -1)) peakMemoryMb = usedMb;
      } catch {
        // Container exited between ticks, or a stats-API hiccup — fine.
      }
    })();
  }, STATS_SAMPLE_INTERVAL_MS);
  statsTimer.unref();

  // Wait for completion with timeout
  let exitCode = 0;

  const waited = await waitWithTimeout(
    container.wait() as Promise<{ StatusCode: number }>,
    timeoutSecs * 1000
  ).finally(() => clearInterval(statsTimer));

  if (waited.timedOut) {
    console.log(`[${runId}] Container timed out, stopping...`);
    await writeLifecycleLog(runId, 'WARN', 'Container execution timed out');
    try {
      await container.stop({ t: 10 });
    } catch (err) {
      // Container may have exited or been removed in the race window
      // (e.g. periodic cleanup). A throw here used to escape and flip
      // the run FAILED — the run DID time out, keep 143.
      console.warn(`[${runId}] Stop after timeout failed: ${(err as Error).message}`);
    }
    exitCode = 143; // SIGTERM
  } else {
    exitCode = waited.value.StatusCode;
  }

  const finishedAt = new Date();

  // Read OOM state BEFORE remove() — inspect on a removed container 404s.
  // Best-effort: a failed inspect must not break run terminalization.
  let oomKilled = false;
  try {
    const info = await container.inspect();
    oomKilled = info.State?.OOMKilled === true;
  } catch (err) {
    console.warn(`[${runId}] Inspect after exit failed: ${(err as Error).message}`);
  }

  // Let the attach stream deliver the container's final lines before the
  // finish marker, so "Container finished ..." lands last. Bounded: the
  // container has already exited, so 'end' normally arrives within ms; a
  // wedged stream must not delay terminalization.
  await flushLogs(2000);

  // Log finish message
  await writeLifecycleLog(
    runId,
    exitCode === 0 ? 'INFO' : 'ERROR',
    `Container finished with exit code ${String(exitCode)}${oomKilled ? ' (OOM-killed)' : ''}`
  );

  // Remove container. Best-effort: between wait() and here the container
  // sits in 'exited' state, where the 30-minute cleanup sweep can remove
  // it first. A 404/409 from that race must not escape — it would land in
  // processRun's catch, flip this finished (possibly exit-0) run to
  // FAILED, and even re-execute it via maybeRetryRun.
  try {
    await container.remove();
    console.log(`[${runId}] Container removed`);
  } catch (err) {
    console.warn(
      `[${runId}] Container remove failed (already removed?): ${(err as Error).message}`
    );
  }

  console.log(`[${runId}] Finished with exit code ${String(exitCode)}`);

  return {
    exitCode,
    startedAt,
    peakMemoryMb,
    finishedAt,
    oomKilled,
  };
}

/** Registry auth for docker pull */
function getRegistryAuth():
  | { authconfig?: { username: string; password: string; serveraddress: string } }
  | undefined {
  if (!config.imageRegistry || !config.imageRegistryToken) return undefined;
  const serveraddress = config.imageRegistry.split('/')[0] || '';
  return {
    authconfig: {
      username: config.imageRegistryUser || 'github',
      password: config.imageRegistryToken,
      serveraddress,
    },
  };
}

/** A single JSON frame from docker's pull progress stream. */
export interface PullProgressEvent {
  status?: string;
  error?: string;
  errorDetail?: { message?: string };
}

/** The slice of docker-modem that followPull consumes — injectable for tests. */
export interface PullModem {
  followProgress: (
    stream: NodeJS.ReadableStream,
    onFinished: (err: Error | null) => void,
    onProgress?: (event: PullProgressEvent) => void
  ) => void;
}

/**
 * Follow a docker pull stream to completion, surfacing IN-BODY errors.
 *
 * docker-modem's followProgress treats a clean stream end as success: it
 * never inspects individual frames, but the daemon reports pull failures
 * (disk full, auth, registry rate-limit) as `{"error": ...}` frames on an
 * HTTP 200 stream — the transport 'error' event never fires for those.
 * Verified against docker-modem 5.0.6 (lib/modem.js processLine /
 * onStreamEnd). Without this check a failed pull logs "pulled
 * successfully" and the run dies two calls later at createContainer with
 * a misleading "(HTTP code 404) No such image".
 *
 * Exported for unit tests (fake modem).
 */
export function followPull(modem: PullModem, stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let inBandError: Error | null = null;
    modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) {
          reject(err);
        } else if (inBandError) {
          reject(inBandError);
        } else {
          resolve();
        }
      },
      (event: PullProgressEvent) => {
        if (!inBandError && (event.error || event.errorDetail?.message)) {
          inBandError = new Error(
            `Image pull failed: ${event.errorDetail?.message ?? event.error ?? 'unknown daemon error'}`
          );
        }
      }
    );
  });
}

/**
 * Run `attempt` up to `delaysMs.length + 1` times, sleeping between tries.
 * Returns on the first success; throws the LAST error once retries are
 * exhausted. `onRetry` fires before each sleep with the attempt number and
 * the error that caused it. Exported for unit tests (docker-pull.test.ts).
 */
export async function pullWithRetries(
  attempt: () => Promise<void>,
  opts: {
    delaysMs: number[];
    /** Abort check between attempts — a retry window must not extend an
     * aborted run's hold on its concurrency slot and memory headroom. */
    isAborted?: () => boolean;
    onRetry?: (attemptNo: number, err: Error) => void | Promise<void>;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      await attempt();
      return;
    } catch (err) {
      if (i >= opts.delaysMs.length || opts.isAborted?.()) throw err;
      await opts.onRetry?.(i + 1, err as Error);
      await sleep(opts.delaysMs[i] ?? 0);
    }
  }
}

/**
 * Pull Docker image if not already present.
 * When IMAGE_REGISTRY is configured, always pulls to get the latest version.
 */
async function pullImageIfNeeded(
  image: string,
  runId: string,
  isAborted?: () => boolean
): Promise<void> {
  const isRegistryImage = config.imageRegistry && image.includes(config.imageRegistry);

  // For local images, skip pull if already present
  if (!isRegistryImage) {
    try {
      await docker.getImage(image).inspect();
      console.log(`Image ${image} already exists`);
      await writeLifecycleLog(runId, 'INFO', `Image ${image} already exists locally`);
      return;
    } catch {
      // Image not found locally — will try to pull
    }
  }

  // Pull image (always pull for registry images to get latest)
  console.log(`Pulling image ${image}...`);
  await writeLifecycleLog(runId, 'INFO', `Pulling image ${image}...`);

  const auth = getRegistryAuth();

  const pullOnce = () =>
    new Promise<void>((resolve, reject) => {
      const pullOpts = auth || {};
      void docker.pull(
        image,
        pullOpts,
        (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
          if (err) {
            reject(err);
            return;
          }
          if (!stream) {
            reject(new Error('No stream returned from docker pull'));
            return;
          }

          followPull(docker.modem as PullModem, stream).then(resolve, reject);
        }
      );
    });

  // Transient pulls failures are common exactly when it hurts most: a
  // fleet scale-up cold-pulls the same multi-GB image on every new
  // droplet at once (2026-07-16: 4 runs failed on mid-transfer pull
  // errors and their input chunks were dropped for 24h — nothing
  // upstream retries a run that died before its container existed).
  // Two retries with backoff ride out registry/stream blips; a
  // persistent failure (bad ref, auth) still fails the run with the
  // real error surfaced by followPull.
  await pullWithRetries(pullOnce, {
    delaysMs: [5_000, 15_000],
    isAborted,
    onRetry: async (attemptNo, err) => {
      console.warn(`[${runId}] Pull attempt ${String(attemptNo)} failed: ${err.message}`);
      await writeLifecycleLog(
        runId,
        'WARN',
        `Image pull attempt ${String(attemptNo)} failed (${err.message}); retrying...`
      );
    },
  });

  console.log(`Image ${image} pulled successfully`);
  await writeLifecycleLog(runId, 'INFO', `Image ${image} pulled successfully`);
}

/**
 * Build Apify-compatible environment variables for a run.
 */
export function buildActorEnv(options: {
  runId: string;
  actorId: string;
  userId?: string;
  apiBaseUrl: string;
  token: string;
  defaultDatasetId: string;
  defaultKeyValueStoreId: string;
  defaultRequestQueueId: string;
  memoryMbytes?: number;
  timeoutSecs?: number;
  proxyPassword?: string | null;
  proxyHostname?: string | null;
  proxyPort?: number | null;
}): Record<string, string> {
  const {
    runId,
    actorId,
    userId,
    apiBaseUrl,
    token,
    defaultDatasetId,
    defaultKeyValueStoreId,
    defaultRequestQueueId,
    memoryMbytes = config.defaultMemoryMb,
    timeoutSecs = config.defaultTimeoutSecs,
  } = options;

  const timeoutAt = new Date(Date.now() + timeoutSecs * 1000).toISOString();
  const containerApiBaseUrl = translateLocalhostForContainer(apiBaseUrl);

  const env: Record<string, string> = {
    // Identity
    APIFY_ACTOR_ID: actorId,
    APIFY_ACTOR_RUN_ID: runId,
    APIFY_USER_ID: userId ?? 'anonymous',

    // API connection (rewritten on macOS so the actor container can reach back
    // to the host-running API; see translateLocalhostForContainer).
    APIFY_API_BASE_URL: containerApiBaseUrl,
    APIFY_TOKEN: token,
    APIFY_API_PUBLIC_BASE_URL: containerApiBaseUrl,

    // Storage IDs
    APIFY_DEFAULT_DATASET_ID: defaultDatasetId,
    APIFY_DEFAULT_KEY_VALUE_STORE_ID: defaultKeyValueStoreId,
    APIFY_DEFAULT_REQUEST_QUEUE_ID: defaultRequestQueueId,

    // Runtime flags
    APIFY_IS_AT_HOME: '1',
    APIFY_HEADLESS: '1',
    APIFY_MEMORY_MBYTES: String(memoryMbytes),
    APIFY_TIMEOUT_AT: timeoutAt,

    // Input key
    APIFY_INPUT_KEY: 'INPUT',

    // Container info
    APIFY_CONTAINER_PORT: '4321',
    APIFY_CONTAINER_URL: `http://run-${runId}:4321`,

    // Also set CRAWLEE_ variants for newer crawlers
    CRAWLEE_STORAGE_DIR: '/tmp/storage',
  };

  // Apify proxy env injection — only when non-null. An empty env var
  // routes the SDK through the present-path with a bad value (confusing
  // 401s); absent var activates the well-tested API fallback to
  // /v2/users/me. See proxy-resolver.ts for resolution semantics.
  if (options.proxyPassword) env.APIFY_PROXY_PASSWORD = options.proxyPassword;
  if (options.proxyHostname) env.APIFY_PROXY_HOSTNAME = options.proxyHostname;
  if (options.proxyPort) env.APIFY_PROXY_PORT = String(options.proxyPort);

  return env;
}

/**
 * Clean up Docker resources to free disk space.
 * Removes: stopped containers, dangling images, build cache.
 * Keeps images used in the last 24h.
 */
export async function cleanupDocker(): Promise<void> {
  try {
    // Remove stopped containers — ONLY ours. The label filter matches
    // listRunningContainers/stopRun; without it this swept every exited
    // container on the host (innocent bystanders on shared Docker hosts)
    // and widened the remove()-race window in executeRun.
    const containers = await docker.listContainers({
      all: true,
      filters: { status: ['exited', 'dead'], label: ['crawlee-cloud.run-id'] },
    });
    for (const c of containers) {
      try {
        await docker.getContainer(c.Id).remove();
      } catch {
        // ignore
      }
    }
    if (containers.length > 0) {
      console.log(`[Cleanup] Removed ${String(containers.length)} stopped container(s)`);
    }

    // Prune dangling images
    const pruneResult = await docker.pruneImages({ filters: { dangling: { true: true } } });
    const reclaimedMb = Math.round((pruneResult.SpaceReclaimed || 0) / 1024 / 1024);
    if (reclaimedMb > 0) {
      console.log(`[Cleanup] Pruned dangling images: ${String(reclaimedMb)}MB freed`);
    }

    // Prune build cache
    await docker.pruneBuilder();
  } catch (err) {
    console.error('[Cleanup] Error:', (err as Error).message);
  }
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/** Start periodic Docker cleanup (every 30 minutes) */
export function startPeriodicCleanup(): void {
  const intervalMs = 30 * 60 * 1000;
  console.log('[Cleanup] Starting periodic Docker cleanup (every 30m)');
  cleanupInterval = setInterval(() => {
    void cleanupDocker();
  }, intervalMs);
}

/** Stop periodic cleanup */
export function stopPeriodicCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Check Docker daemon connectivity.
 */
export async function checkDocker(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * List all running Actor containers.
 */
export async function listRunningContainers(): Promise<Docker.ContainerInfo[]> {
  const containers = await docker.listContainers({
    filters: {
      label: ['crawlee-cloud.run-id'],
    },
  });
  return containers;
}

/**
 * Stop a specific run's container.
 *
 * Lists with `all: true`: without it, a container that exists but is not
 * yet running (created, start() pending — the abort-vs-start race) is
 * invisible and the abort is silently lost. Running containers get a
 * graceful stop (SIGTERM, 10s); non-running ones are force-removed —
 * stop() on a created container errors, and there is no process to let
 * exit gracefully anyway.
 */
export async function stopRun(runId: string): Promise<void> {
  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: [`crawlee-cloud.run-id=${runId}`],
    },
  });

  for (const containerInfo of containers) {
    const container = docker.getContainer(containerInfo.Id);
    if (containerInfo.State === 'running') {
      await container.stop({ t: 10 });
      console.log(`Stopped container ${containerInfo.Id} for run ${runId}`);
    } else {
      await container.remove({ force: true });
      console.log(
        `Removed non-running container ${containerInfo.Id} (${containerInfo.State}) for run ${runId}`
      );
    }
  }
}
