/**
 * API client for Crawlee Platform.
 *
 * Handles authenticated requests to the backend API.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/**
 * Apify-shaped pagination envelope. The API's list endpoints return this
 * shape under `data`. `total` is the real row count from a parallel
 * COUNT(*) query (not the page length); `count` is the page length.
 *
 * Use {@link Pagination} from @/components/pagination for prev/next UI.
 */
export interface Page<T> {
  items: T[];
  total: number;
  count: number;
  offset: number;
  limit: number;
}

/** Common params shape for list endpoints. */
export interface PageParams {
  offset?: number;
  limit?: number;
}

/** Build a `?offset=N&limit=N` querystring (omitting unset values). */
function pageQuery(params?: PageParams): string {
  if (!params) return '';
  const qs = new URLSearchParams();
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export interface Run {
  id: string;
  actId: string;
  status: 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED-OUT' | 'ABORTING' | 'ABORTED';
  statusMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  defaultDatasetId?: string;
  defaultKeyValueStoreId?: string;
  defaultRequestQueueId?: string;
  // Server returns these nested under `options` (Apify-compatible shape).
  options?: {
    timeoutSecs?: number;
    memoryMbytes?: number;
  };
  createdAt: string;
  modifiedAt: string;
}

export interface ActorDefaultRunOptions {
  build?: string;
  timeoutSecs?: number;
  memoryMbytes?: number;
  /** Full image reference written by `crc push` (e.g. `ghcr.io/org/repo/actor-foo:latest`). */
  image?: string;
  /** Per-actor env vars merged into every run's container environment. */
  envVars?: Record<string, string>;
}

export interface Actor {
  id: string;
  name: string;
  title?: string;
  description?: string;
  userId?: string;
  defaultRunOptions?: ActorDefaultRunOptions;
  maxRetries?: number;
  retryDelaySecs?: number;
  createdAt: string;
  modifiedAt: string;
}

export interface ActorBuild {
  id: string;
  actorId: string;
  versionId: string | null;
  // Joined from actor_versions on the list endpoint. Null when a build's
  // version was deleted (CASCADE SET NULL on actor_versions).
  versionNumber: string | null;
  // Mutable tag — usually "latest", may be "beta", etc. The "current
  // pointer" semantic; runs without an explicit tag resolve through it.
  buildTag: string | null;
  status: string; // PENDING | BUILDING | SUCCEEDED | FAILED | ABORTED
  startedAt: string | null;
  finishedAt: string | null;
  imageName: string | null;
  imageDigest: string | null;
  imageSizeBytes: number | null;
  logCount: number;
  gitBranch: string | null;
  gitCommit: string | null;
  createdAt: string;
}

export interface ActorVersion {
  id: string;
  actorId: string;
  versionNumber: string;
  sourceType?: string;
  sourceUrl?: string;
  buildTag?: string;
  envVars?: Record<string, string>;
  isDeprecated: boolean;
  createdAt: string;
}

export interface Webhook {
  id: string;
  userId: string;
  eventTypes: string[];
  requestUrl: string;
  payloadTemplate?: string | null;
  actorId?: string | null;
  headers?: Record<string, string> | null;
  description?: string | null;
  isEnabled: boolean;
  createdAt: string;
  modifiedAt: string;
}

export interface Schedule {
  id: string;
  userId: string | null;
  actorId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  isEnabled: boolean;
  input?: unknown;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  modifiedAt: string;
}

export interface KeyValueStore {
  id: string;
  name: string | null;
  userId: string | null;
  createdAt: string;
  modifiedAt: string;
  accessedAt: string;
}

export interface KVKey {
  key: string;
  size: number;
}

export interface RequestQueue {
  id: string;
  name: string | null;
  userId: string | null;
  createdAt: string;
  modifiedAt: string;
  accessedAt: string;
  totalRequestCount: number;
  handledRequestCount: number;
  pendingRequestCount: number;
  hadMultipleClients: boolean;
}

export interface RunnerInfo {
  id: string;
  ip: string;
  status: 'creating' | 'ready' | 'busy' | 'draining' | 'dead' | 'destroying';
  createdAt: string;
  activeRuns: number;
}

export interface ScalerStatus {
  enabled: boolean;
  provider: string;
  runners: RunnerInfo[];
  heartbeats: Record<string, unknown>[];
  queue: { ready: number; running: number; total: number };
  config: { min: number; max: number; runsPerRunner: number };
}

/**
 * Wire shape returned by GET /v2/system/retention/status (admin-only).
 * `lastTickAt` / `lastTickElapsedMs` are null when the reaper has never
 * ticked since the Redis hash was last written or wiped.
 */
export interface RetentionStatus {
  enabled: boolean;
  lastTickAt: string | null;
  lastTickElapsedMs: number | null;
  reapedLast24h: {
    dataset: number;
    key_value_store: number;
    request_queue: number;
    run: number;
  };
  tombstoneRowCount: number;
}

/**
 * Wire shape returned by GET /v2/webhooks/:id/deliveries and
 * POST /v2/webhooks/:id/test. Field names mirror the API's `formatDelivery`
 * helper exactly — earlier this type used `statusCode` / `errorMessage` /
 * `deliveredAt` (none of which the API ever returned), so every row in the
 * dashboard rendered as undefined.
 */
export interface WebhookDelivery {
  id: string;
  webhookId: string;
  runId: string | null;
  eventType: string;
  /** 'PENDING' | 'DELIVERED' | 'FAILED' — uppercase, matches the DB enum */
  status: string;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  /** HTTP response status from the receiver, null on network error */
  responseStatus: number | null;
  /** First 1024 chars of the response body OR the error message on a network failure */
  responseBody: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Dataset {
  id: string;
  name?: string;
  userId?: string;
  itemCount: number;
  createdAt: string;
  modifiedAt: string;
  accessedAt: string;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  role: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  keyPreview: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

/**
 * Fetch a streaming response and open it in a new tab as a blob URL —
 * guaranteeing inline display regardless of how the server's
 * Content-Disposition is interpreted. Used by "view raw" buttons.
 *
 * Why blob instead of opening the URL directly?
 *   - `Content-Disposition: inline` is unreliable cross-browser when the
 *     URL has no recognized extension or includes a filename hint.
 *   - Blob URLs with explicit MIME types are treated as standalone tabs by
 *     every browser; no extension heuristics, no download policy.
 *   - Auth happens via the bearer header (not query-token), so the JWT
 *     doesn't leak into URL bars / referrer / server logs.
 *
 * NOTE on `window.open` features: we deliberately do NOT pass `noopener` /
 * `noreferrer`. With `noopener` the spec mandates a null return value so
 * the parent can't reach into the new tab — but that breaks the
 * placeholder-redirect trick. We sever the relationship manually after
 * navigation by setting `placeholder.opener = null`. The blob URL is
 * same-origin and created by us, so the brief opener exposure is safe.
 *
 * Buffers the entire response in memory before opening the tab. Fine for
 * the preview-sized logs/records this is wired to (kilobytes); not suitable
 * for full multi-GB datasets.
 */
export async function openInTabAsBlob(
  endpoint: string,
  mimeType = 'text/plain; charset=utf-8'
): Promise<void> {
  // Open placeholder WITHOUT noopener so we get a real WindowProxy back.
  // The placeholder appears immediately on the user's click, satisfying
  // popup-blocker user-activation requirements; we then redirect it once
  // the fetch settles.
  const placeholder = window.open('about:blank', '_blank');
  try {
    const token = getToken();
    const res = await fetch(`${API_URL}${endpoint}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const typed = new Blob([blob], { type: mimeType });
    const url = URL.createObjectURL(typed);
    if (placeholder) {
      placeholder.location.href = url;
      // Sever the opener relationship after navigation — same-origin blob,
      // no real risk, but no upside to leaving the link in place either.
      try {
        placeholder.opener = null;
      } catch {
        /* cross-origin once redirected; ignore */
      }
      // Revoke after the new tab has had a chance to load.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else {
      // Popup blocker won the race. Fall back to current-tab nav so the
      // user at least gets the content rather than a silent failure.
      window.location.href = url;
    }
  } catch (err) {
    placeholder?.close();
    throw err;
  }
}

/**
 * Fetch a streaming endpoint and trigger a download with a fully controlled
 * filename. Bypasses the URL/Content-Disposition naming guesswork.
 *
 * The blob is intentionally typed `application/octet-stream` (not the
 * actual content type). When the browser sees `<a download>` to a same-
 * origin blob URL it SHOULD always download — but some Chromium builds /
 * extensions / configurations defeat the `download` attribute when the
 * MIME is something the browser can natively render (JSON, text). Octet-
 * stream is opaque, leaves no inline-open path, and forces the save dialog.
 * The `download="…json"` attribute still gives the saved file the right
 * extension. The user's browser doesn't lose anything — they wanted to save
 * the file, not open it.
 *
 * Same memory tradeoff as `openInTabAsBlob` — the response is buffered
 * before the download starts. For datasets at extreme scale (>500MB) a
 * server-side multipart-streaming approach would be better, but for
 * typical operator-grade exports this is the robust path.
 */
export async function downloadAsBlob(endpoint: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_URL}${endpoint}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  // Force octet-stream so the browser can't decide to render it inline.
  const typed = new Blob([blob], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(typed);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    // Some browsers ignore download on links that open in a new tab —
    // keep target unset so it stays in the current navigation context
    // (the click handler is sync, no actual navigation happens).
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke after the download has had a chance to start. Some browsers
    // need the URL to live for a moment after click().
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }
}

/**
 * Get a 1-hour presigned S3 URL for a KV record. The URL points directly at
 * S3, so the browser can open it without any auth — no API server in the
 * data path. Returns null if the record doesn't exist.
 */
/**
 * Fetch the raw bytes of a KV record, capped at `maxBytes` to keep the
 * dashboard out of trouble when an actor has stored an 800 KB session pool
 * or a 5 MB HTML snapshot. Returns the text (decoded as UTF-8 — works for
 * JSON, plain text, logs; returns garbled output for binary which the
 * caller can detect and offer the "view full" path instead).
 *
 * `truncated` tells the caller whether more content exists beyond what
 * was returned — separate from the parse-success of the body itself.
 */
export async function fetchKVRecordContent(
  storeId: string,
  key: string,
  maxBytes = 8192
): Promise<{ text: string; truncated: boolean; size: number; contentType: string } | null> {
  const token = getToken();
  const res = await fetch(
    `${API_URL}/v2/key-value-stores/${storeId}/records/${encodeURIComponent(key)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const blob = await res.blob();
  const size = blob.size;
  const truncated = size > maxBytes;
  // Slice in the *Blob* before decoding so we don't load 5MB into a string
  // just to throw away most of it. Slicing a Blob is constant-time.
  const slice = truncated ? blob.slice(0, maxBytes) : blob;
  const text = await slice.text();
  return {
    text,
    truncated,
    size,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
}

export async function getKVRecordPresignedUrl(
  storeId: string,
  key: string
): Promise<{ url: string; expiresAt: string } | null> {
  try {
    const res = await fetchApi<{ data: { url: string; expiresAt: string } }>(
      `/v2/key-value-stores/${storeId}/records/${encodeURIComponent(key)}?presigned=1`
    );
    return res.data;
  } catch (err) {
    // 404 from a missing record bubbles up as a thrown Error from fetchApi —
    // treat it as "no record" rather than a hard failure.
    if (err instanceof Error && /not found/i.test(err.message)) return null;
    throw err;
  }
}

async function fetchApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: 'Request failed' } }));
    throw new Error(error.error?.message || 'Request failed');
  }

  if (res.status === 204) {
    return {} as T;
  }

  return res.json();
}

// Auth
export async function getCurrentUser(): Promise<User> {
  const res = await fetchApi<{ data: User }>('/v2/auth/me');
  return res.data;
}

export async function getApiKeys(): Promise<ApiKey[]> {
  const res = await fetchApi<{ data: ApiKey[] }>('/v2/auth/api-keys');
  return res.data;
}

export async function createApiKey(
  name: string
): Promise<{ id: string; name: string; key: string }> {
  const res = await fetchApi<{ data: { id: string; name: string; key: string } }>(
    '/v2/auth/api-keys',
    {
      method: 'POST',
      body: JSON.stringify({ name }),
    }
  );
  return res.data;
}

export async function revokeApiKey(id: string): Promise<void> {
  await fetchApi(`/v2/auth/api-keys/${id}`, { method: 'DELETE' });
}

// System info — aggregate for the Settings page (version, storage health,
// execution defaults, scaler state). One call, fewer round trips.

export interface StorageCheck {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
}

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  storage: { db: StorageCheck; redis: StorageCheck; s3: StorageCheck };
  executionDefaults: {
    maxConcurrentRuns: number;
    defaultMemoryMb: number;
    defaultTimeoutSecs: number;
  };
  scaler: { enabled: boolean; provider: string; minRunners: number; maxRunners: number };
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const res = await fetchApi<{ data: SystemInfo }>('/v2/system/info');
  return res.data;
}

// Runs
export interface ListRunsParams {
  status?: Run['status'];
  actorId?: string;
  /** ISO datetime — runs with created_at >= since */
  since?: string;
  /** ISO datetime — runs with created_at < until */
  until?: string;
  /** page size, default 50, max 200 */
  limit?: number;
  /** page offset, default 0 */
  offset?: number;
  /** sort by created_at desc (default true) */
  desc?: boolean;
}

export interface RunsListPage {
  total: number;
  count: number;
  offset: number;
  limit: number;
  desc: boolean;
  items: Run[];
}

/**
 * List runs with server-side filter + pagination. Returns the page envelope
 * so callers can render "showing X of Y" honestly. At platform scale (8k+
 * runs/month), client-side filtering would silently drop data past the page.
 */
export async function listRuns(params: ListRunsParams = {}): Promise<RunsListPage> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.actorId) qs.set('actorId', params.actorId);
  if (params.since) qs.set('since', params.since);
  if (params.until) qs.set('until', params.until);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.desc !== undefined) qs.set('desc', String(params.desc));
  const url = `/v2/actor-runs${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetchApi<{ data: RunsListPage }>(url);
  return res.data;
}

/**
 * Items-only convenience for legacy callers. New code should prefer listRuns().
 */
export async function getRuns(): Promise<Run[]> {
  const page = await listRuns();
  return page.items;
}

export async function getRun(id: string): Promise<Run> {
  const res = await fetchApi<{ data: Run }>(`/v2/actor-runs/${id}`);
  return res.data;
}

export async function startRun(
  actorId: string,
  options?: { input?: unknown; timeout?: number; memory?: number }
): Promise<Run> {
  const res = await fetchApi<{ data: Run }>(`/v2/acts/${actorId}/runs`, {
    method: 'POST',
    body: JSON.stringify({
      input: options?.input,
      timeout: options?.timeout,
      memory: options?.memory,
    }),
  });
  return res.data;
}

export async function abortRun(id: string): Promise<Run> {
  const res = await fetchApi<{ data: Run }>(`/v2/actor-runs/${id}/abort`, { method: 'POST' });
  return res.data;
}

export async function getActorRuns(actorId: string): Promise<Run[]> {
  // Get all runs and filter by actId
  const runs = await getRuns();
  return runs.filter((r) => r.actId === actorId);
}

// Actors
export async function getActors(params?: PageParams): Promise<Page<Actor>> {
  const res = await fetchApi<{ data: Page<Actor> }>(`/v2/acts${pageQuery(params)}`);
  return res.data;
}

export async function getActor(id: string): Promise<Actor> {
  const res = await fetchApi<{ data: Actor }>(`/v2/acts/${id}`);
  return res.data;
}

export async function createActor(data: {
  name: string;
  title?: string;
  description?: string;
}): Promise<Actor> {
  const res = await fetchApi<{ data: Actor }>('/v2/acts', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.data;
}

export async function deleteActor(id: string): Promise<void> {
  await fetchApi(`/v2/acts/${id}`, { method: 'DELETE' });
}

// Datasets
export async function getDatasets(params?: PageParams): Promise<Page<Dataset>> {
  const res = await fetchApi<{ data: Page<Dataset> }>(`/v2/datasets${pageQuery(params)}`);
  return res.data;
}

export async function getDataset(id: string): Promise<Dataset> {
  const res = await fetchApi<{ data: Dataset }>(`/v2/datasets/${id}`);
  return res.data;
}

export async function getDatasetItems(
  id: string,
  options?: { offset?: number; limit?: number }
): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (options?.offset !== undefined) params.append('offset', String(options.offset));
  if (options?.limit !== undefined) params.append('limit', String(options.limit));

  const queryString = params.toString() ? `?${params.toString()}` : '';
  // API accepts arbitrary JSON (POST /v2/datasets/:id/items wraps non-arrays
  // into a single-element list), so items can be objects, scalars, or arrays.
  // Callers must narrow per their own rendering needs.
  const res = await fetchApi<unknown[]>(`/v2/datasets/${id}/items${queryString}`);
  return res;
}

export async function deleteDataset(id: string): Promise<void> {
  await fetchApi(`/v2/datasets/${id}`, { method: 'DELETE' });
}

// Stats (aggregated from other calls)
export interface LogLine {
  timestamp: string;
  level: string;
  message: string;
}

export interface LogPage {
  /** Offset of the first returned line in the full log. */
  offset: number;
  /** Page size requested. */
  limit: number;
  /** Total number of lines in the log right now. */
  total: number;
  /** Number of lines actually returned (may be less than limit at end). */
  count: number;
  items: LogLine[];
}

/**
 * Fetch a page of logs. By default, `tail: true` returns the LAST `limit`
 * lines — what operators triaging failed runs actually want. Pass an explicit
 * offset to load older pages.
 */
export async function getRunLogs(
  runId: string,
  options?: { offset?: number; limit?: number; tail?: boolean }
): Promise<LogPage> {
  const params = new URLSearchParams();
  if (options?.offset !== undefined) params.append('offset', String(options.offset));
  if (options?.limit !== undefined) params.append('limit', String(options.limit));
  if (options?.tail) params.append('tail', 'true');

  const queryString = params.toString() ? `?${params.toString()}` : '';
  const res = await fetchApi<{ data: LogPage }>(`/v2/actor-runs/${runId}/logs${queryString}`);
  return res.data;
}

export async function getRunInput(runId: string): Promise<unknown> {
  try {
    // Get run info to find the default KV store
    const run = await getRun(runId);
    if (!run.defaultKeyValueStoreId) return null;

    // Fetch INPUT record from the KV store
    const res = await fetchApi<unknown>(
      `/v2/key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT`
    );
    return res;
  } catch {
    return null;
  }
}

export async function getRunDatasetItems(
  runId: string,
  options?: { offset?: number; limit?: number }
): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (options?.offset !== undefined) params.append('offset', String(options.offset));
  if (options?.limit !== undefined) params.append('limit', String(options.limit));

  const queryString = params.toString() ? `?${params.toString()}` : '';
  try {
    const res = await fetchApi<unknown[]>(`/v2/actor-runs/${runId}/dataset/items${queryString}`);
    return res;
  } catch {
    return [];
  }
}

export async function getDashboardStats(): Promise<{
  totalRuns: number;
  activeActors: number;
  totalDatasets: number;
  successRate: number;
  runningCount: number;
  failedLast24h: number;
}> {
  try {
    // Stat counts come from the page envelope's `total` (real COUNT(*) on
    // the API side) rather than `items.length`. We pass `limit: 1` because
    // the items themselves are unused — only the total matters for the
    // counter tiles on the home dashboard.
    const emptyPage = <T>(): Page<T> => ({ items: [], total: 0, count: 0, offset: 0, limit: 0 });
    const [runs, actors, datasets] = await Promise.all([
      getRuns().catch(() => [] as Run[]),
      getActors({ limit: 1 }).catch(() => emptyPage<Actor>()),
      getDatasets({ limit: 1 }).catch(() => emptyPage<Dataset>()),
    ]);

    const succeeded = runs.filter((r) => r.status === 'SUCCEEDED').length;
    const failed = runs.filter((r) => r.status === 'FAILED').length;
    const successRate = succeeded + failed > 0 ? (succeeded / (succeeded + failed)) * 100 : 100;
    const runningCount = runs.filter((r) => r.status === 'RUNNING').length;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const failedLast24h = runs.filter(
      (r) => r.status === 'FAILED' && new Date(r.createdAt).getTime() >= dayAgo
    ).length;

    return {
      totalRuns: runs.length,
      activeActors: actors.total,
      totalDatasets: datasets.total,
      successRate: Math.round(successRate),
      runningCount,
      failedLast24h,
    };
  } catch {
    return {
      totalRuns: 0,
      activeActors: 0,
      totalDatasets: 0,
      successRate: 100,
      runningCount: 0,
      failedLast24h: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Actor mutations
// ---------------------------------------------------------------------------

export async function updateActor(
  id: string,
  patch: Partial<{
    title: string;
    description: string;
    defaultRunOptions: ActorDefaultRunOptions;
    maxRetries: number;
    retryDelaySecs: number;
  }>
): Promise<Actor> {
  const res = await fetchApi<{ data: Actor }>(`/v2/acts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

export async function getBuilds(actorId: string): Promise<ActorBuild[]> {
  const res = await fetchApi<{ data: { items: ActorBuild[] } }>(`/v2/acts/${actorId}/builds`);
  return res.data.items;
}

export async function getBuild(actorId: string, buildId: string): Promise<ActorBuild> {
  const res = await fetchApi<{ data: ActorBuild }>(`/v2/acts/${actorId}/builds/${buildId}`);
  return res.data;
}

export async function startBuild(
  actorId: string,
  body: {
    versionNumber: string;
    sourceType?: string;
    sourceUrl?: string;
    dockerfile?: string;
    buildTag?: string;
    envVars?: Record<string, string>;
  }
): Promise<ActorBuild> {
  const res = await fetchApi<{ data: ActorBuild }>(`/v2/acts/${actorId}/builds`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.data;
}

export async function abortBuild(actorId: string, buildId: string): Promise<ActorBuild> {
  const res = await fetchApi<{ data: ActorBuild }>(`/v2/acts/${actorId}/builds/${buildId}/abort`, {
    method: 'POST',
  });
  return res.data;
}

export async function getVersions(actorId: string): Promise<ActorVersion[]> {
  const res = await fetchApi<{ data: { items: ActorVersion[] } }>(`/v2/acts/${actorId}/versions`);
  return res.data.items;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export async function getWebhooks(params?: PageParams): Promise<Page<Webhook>> {
  const res = await fetchApi<{ data: Page<Webhook> }>(`/v2/webhooks${pageQuery(params)}`);
  return res.data;
}

export async function getWebhook(id: string): Promise<Webhook> {
  const res = await fetchApi<{ data: Webhook }>(`/v2/webhooks/${id}`);
  return res.data;
}

export async function createWebhook(body: {
  eventTypes: string[];
  requestUrl: string;
  payloadTemplate?: string;
  actorId?: string;
  headers?: Record<string, string>;
  description?: string;
  isEnabled?: boolean;
}): Promise<Webhook> {
  const res = await fetchApi<{ data: Webhook }>('/v2/webhooks', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.data;
}

export async function updateWebhook(
  id: string,
  patch: Partial<{
    eventTypes: string[];
    requestUrl: string;
    payloadTemplate: string;
    actorId: string;
    headers: Record<string, string>;
    description: string;
    isEnabled: boolean;
  }>
): Promise<Webhook> {
  const res = await fetchApi<{ data: Webhook }>(`/v2/webhooks/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  return res.data;
}

export async function deleteWebhook(id: string): Promise<void> {
  await fetchApi(`/v2/webhooks/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Schedules — cron-driven actor runs
// ---------------------------------------------------------------------------

export async function getSchedules(params?: PageParams): Promise<Page<Schedule>> {
  const res = await fetchApi<{ data: Page<Schedule> }>(`/v2/schedules${pageQuery(params)}`);
  return res.data;
}

export async function createSchedule(body: {
  actorId: string;
  name: string;
  cronExpression: string;
  timezone?: string;
  isEnabled?: boolean;
  input?: unknown;
}): Promise<Schedule> {
  const res = await fetchApi<{ data: Schedule }>('/v2/schedules', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.data;
}

export async function updateSchedule(
  id: string,
  patch: Partial<{
    name: string;
    cronExpression: string;
    timezone: string;
    isEnabled: boolean;
    input: unknown;
  }>
): Promise<Schedule> {
  const res = await fetchApi<{ data: Schedule }>(`/v2/schedules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  return res.data;
}

export async function deleteSchedule(id: string): Promise<void> {
  await fetchApi(`/v2/schedules/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Key-Value Stores
// ---------------------------------------------------------------------------

export async function getKeyValueStores(params?: PageParams): Promise<Page<KeyValueStore>> {
  const res = await fetchApi<{ data: Page<KeyValueStore> }>(
    `/v2/key-value-stores${pageQuery(params)}`
  );
  return res.data;
}

export async function getKeyValueStore(id: string): Promise<KeyValueStore> {
  const res = await fetchApi<{ data: KeyValueStore }>(`/v2/key-value-stores/${id}`);
  return res.data;
}

export async function deleteKeyValueStore(id: string): Promise<void> {
  await fetchApi(`/v2/key-value-stores/${id}`, { method: 'DELETE' });
}

export async function getKVKeys(
  storeId: string,
  options?: { limit?: number; exclusiveStartKey?: string }
): Promise<{ items: KVKey[]; isTruncated: boolean; nextExclusiveStartKey: string | null }> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.append('limit', String(options.limit));
  if (options?.exclusiveStartKey) params.append('exclusiveStartKey', options.exclusiveStartKey);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetchApi<{
    data: {
      items: KVKey[];
      isTruncated: boolean;
      nextExclusiveStartKey: string | null;
    };
  }>(`/v2/key-value-stores/${storeId}/keys${qs}`);
  return res.data;
}

// ---------------------------------------------------------------------------
// Request Queues
// ---------------------------------------------------------------------------

export async function getRequestQueues(params?: PageParams): Promise<Page<RequestQueue>> {
  const res = await fetchApi<{ data: Page<RequestQueue> }>(
    `/v2/request-queues${pageQuery(params)}`
  );
  return res.data;
}

export async function getRequestQueue(id: string): Promise<RequestQueue> {
  const res = await fetchApi<{ data: RequestQueue }>(`/v2/request-queues/${id}`);
  return res.data;
}

export async function deleteRequestQueue(id: string): Promise<void> {
  await fetchApi(`/v2/request-queues/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Scaler / Runners — admin-only endpoint
// ---------------------------------------------------------------------------

/**
 * Find which run "produced" a given default storage record.
 *
 * The relationship lives on the runs table (default_dataset_id /
 * default_key_value_store_id / default_request_queue_id). The API
 * doesn't expose a reverse-lookup endpoint, so we fetch the user's
 * runs once and filter client-side. Acceptable for typical workloads
 * (the API caps the run list at 100). Pass `runs` if you already
 * have them loaded to avoid an extra request.
 */
export async function findProducingRun(
  storageType: 'dataset' | 'kv' | 'queue',
  storageId: string,
  runs?: Run[]
): Promise<Run | null> {
  const list = runs ?? (await getRuns().catch(() => [] as Run[]));
  const field =
    storageType === 'dataset'
      ? 'defaultDatasetId'
      : storageType === 'kv'
        ? 'defaultKeyValueStoreId'
        : 'defaultRequestQueueId';
  return list.find((r) => r[field] === storageId) ?? null;
}

export async function getScalerStatus(): Promise<ScalerStatus> {
  const res = await fetchApi<{ data: ScalerStatus }>('/v2/scaler/status');
  return res.data;
}

export async function getRetentionStatus(): Promise<RetentionStatus> {
  const res = await fetchApi<{ data: RetentionStatus }>('/v2/system/retention/status');
  return res.data;
}

export async function getWebhookDeliveries(id: string): Promise<WebhookDelivery[]> {
  // API path is /deliveries (was previously calling /dispatches and swallowing
  // the 404, which made the deliveries list silently empty).
  const res = await fetchApi<{ data: { items: WebhookDelivery[] } }>(
    `/v2/webhooks/${id}/deliveries`
  );
  return res.data.items;
}

/**
 * Fire a synthetic event at the webhook's URL — one shot, no retries, 10s
 * timeout. The response includes the resulting delivery row so the UI can
 * render the result inline without polling.
 */
/**
 * Fire a synthetic event at the webhook's URL. When `eventType` is omitted
 * the API uses the first event the webhook is subscribed to. To exercise
 * every subscribed event call once per event in parallel — see the Webhooks
 * page handler for the multi-event flow.
 */
export async function testWebhook(id: string, eventType?: string): Promise<WebhookDelivery> {
  // Send an empty JSON object as the body — fetchApi sets
  // `Content-Type: application/json` by default, and Fastify's JSON
  // parser rejects empty bodies under that content-type with
  // "Body cannot be empty when content-type is set to 'application/json'".
  const res = await fetchApi<{ data: WebhookDelivery }>(`/v2/webhooks/${id}/test`, {
    method: 'POST',
    body: JSON.stringify(eventType ? { eventType } : {}),
  });
  return res.data;
}
