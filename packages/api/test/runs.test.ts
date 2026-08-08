/**
 * Actor Runs Routes Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

// Mock authenticate middleware BEFORE importing routes
vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { id: 'test-user-id', email: 'test@example.com', role: 'user' };
  },
}));

import { runsRoutes } from '../src/routes/runs.js';

const mockQuery = vi.fn();
// The rerun endpoint runs its inserts on a dedicated client inside a
// transaction. Transaction-control statements (BEGIN/COMMIT/ROLLBACK)
// auto-resolve and are recorded in txStatements so tests can assert
// transactional behavior without queuing slots for them; every other
// client query shares mockQuery with the pool helper, keeping one
// ordered mock sequence per test.
const txStatements: string[] = [];
const mockRelease = vi.fn();
const mockClient = {
  query: (...args: unknown[]) => {
    const sql = (args[0] as string).trim().toUpperCase();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      txStatements.push(sql);
      return Promise.resolve({ rows: [] });
    }
    return mockQuery(...args);
  },
  release: (...args: unknown[]) => mockRelease(...args),
};
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getClient: () => Promise.resolve(mockClient),
}));

vi.mock('../src/storage/s3.js', () => ({
  listDatasetItems: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getKVRecord: vi.fn().mockResolvedValue(null),
  putKVRecord: vi.fn().mockResolvedValue(undefined),
}));

const mockPublish = vi.fn();
const mockRedisGet = vi.fn().mockResolvedValue(null);
const mockRedisSet = vi.fn().mockResolvedValue('OK');
vi.mock('../src/storage/redis.js', () => ({
  redis: {
    publish: (...args: unknown[]) => mockPublish(...args),
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
  },
}));

vi.mock('../src/config.js', () => ({
  config: { apifyCuPrice: 0.4 },
}));

const createRunRow = (overrides = {}) => ({
  id: 'run-1',
  actor_id: 'actor-1',
  user_id: null,
  status: 'RUNNING',
  status_message: null,
  started_at: new Date(),
  finished_at: null,
  default_dataset_id: 'ds-1',
  default_key_value_store_id: 'kv-1',
  default_request_queue_id: 'queue-1',
  timeout_secs: 3600,
  memory_mbytes: 1024,
  container_url: null,
  created_at: new Date(),
  modified_at: new Date(),
  // Joined column from the LEFT JOIN datasets — every formatRun-feeding
  // query in routes/runs.ts returns this; tests must mirror that shape
  // or they're testing a fictional contract.
  default_dataset_item_count: 0,
  ...overrides,
});

describe('Actor Runs Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.register(runsRoutes, { prefix: '/v2' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockPublish.mockReset();
    mockRelease.mockReset();
    txStatements.length = 0;
  });

  describe('GET /v2/actor-runs', () => {
    it('should list runs (with real total via COUNT)', async () => {
      // Route runs COUNT(*) and the page SELECT in parallel — mock both.
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '2' }] }).mockResolvedValueOnce({
        rows: [createRunRow(), createRunRow({ id: 'run-2', status: 'SUCCEEDED' })],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.total).toBe(2);
      expect(body.data.limit).toBe(50);
      expect(body.data.offset).toBe(0);
    });

    it('exposes defaultDatasetItemCount + stats.datasetItemCount on every formatRun output (v1.0 shape contract)', async () => {
      // This locks the 1.0 semver-committed run-response shape against
      // the divergence Codex flagged on PR #53: PUT/abort/resurrect used
      // RETURNING * without the LEFT JOIN and silently produced payloads
      // missing the field. The CTE rewrite fixes the regression class;
      // this assertion makes "every endpoint returns the same shape"
      // an enforced contract instead of a JSDoc claim.
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] }).mockResolvedValueOnce({
        rows: [createRunRow({ default_dataset_item_count: 1247 })],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs' });
      expect(response.statusCode).toBe(200);
      const run = JSON.parse(response.body).data.items[0];

      // Top-level field (dashboard wrapper reads this directly).
      expect(run).toHaveProperty('defaultDatasetItemCount', 1247);
      // Apify-compat nested field (apify-client reads `run.stats.datasetItemCount`).
      expect(run.stats).toHaveProperty('datasetItemCount', 1247);
    });

    it('exposes both fields as null/0 when the run has no default dataset', async () => {
      // The "run failed before SDK init" case: no dataset, count is null.
      // Top-level field is null (semantically "no dataset, no count");
      // stats.datasetItemCount is 0 (Apify clients expect a number, not null).
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] }).mockResolvedValueOnce({
        rows: [createRunRow({ default_dataset_id: null, default_dataset_item_count: null })],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs' });
      const run = JSON.parse(response.body).data.items[0];
      expect(run.defaultDatasetItemCount).toBeNull();
      expect(run.stats.datasetItemCount).toBe(0);
    });
  });

  describe('GET /v2/actor-runs/stats', () => {
    it('returns aggregate counts parsed from server-side COUNT FILTER', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            total: '5234',
            running: '12',
            succeeded: '4200',
            failed: '1022',
            failed_last_24h: '7',
          },
        ],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/stats' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toEqual({
        total: 5234,
        running: 12,
        succeeded: 4200,
        failed: 1022,
        failedLast24h: 7,
      });
    });

    it('scopes to the authenticated user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: '0', running: '0', succeeded: '0', failed: '0', failed_last_24h: '0' }],
      });

      await app.inject({ method: 'GET', url: '/v2/actor-runs/stats' });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][1]).toEqual(['test-user-id']);
    });

    // Locks in the FAILED ∪ TIMED-OUT grouping so the dashboard tile can't
    // silently diverge from the histogram's FAIL caps. ABORTED must stay out
    // (operator-cancellation, not a failure).
    it("groups TIMED-OUT into 'failed' but excludes ABORTED", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: '0', running: '0', succeeded: '0', failed: '0', failed_last_24h: '0' }],
      });

      await app.inject({ method: 'GET', url: '/v2/actor-runs/stats' });

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("status IN ('FAILED', 'TIMED-OUT')");
      expect(sql).not.toContain("'ABORTED'");
    });

    // Pins the hour-aligned 24h window so the tile and the histogram's
    // FAIL caps cover identical timespans. A drift back to NOW()-24h
    // would silently reintroduce up to a 59-minute gap at the top of
    // every hour.
    it('uses the same hour-aligned 24h window as /actor-runs/histogram', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: '0', running: '0', succeeded: '0', failed: '0', failed_last_24h: '0' }],
      });

      await app.inject({ method: 'GET', url: '/v2/actor-runs/stats' });

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("date_trunc('hour', NOW()) - INTERVAL '23 hours'");
      expect(sql).not.toContain("NOW() - INTERVAL '24 hours'");
    });
  });

  describe('GET /v2/actor-runs/histogram', () => {
    it('returns server-shaped buckets with total + failed parsed as numbers', async () => {
      const bucketA = new Date('2026-05-04T10:00:00Z');
      const bucketB = new Date('2026-05-04T11:00:00Z');
      mockQuery.mockResolvedValueOnce({
        rows: [
          { bucket: bucketA, total: '5', failed: '1' },
          { bucket: bucketB, total: '0', failed: '0' },
        ],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/histogram' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.hours).toBe(24);
      expect(body.data.buckets).toEqual([
        { hour: bucketA.toISOString(), total: 5, failed: 1 },
        { hour: bucketB.toISOString(), total: 0, failed: 0 },
      ]);
    });

    it('passes through the user_id and the requested hours window to SQL', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/histogram?hours=6' });

      expect(response.statusCode).toBe(200);
      // The route passes [userId, hours] as bind params; both must reach the DB.
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][1]).toEqual(['test-user-id', 6]);
    });

    it('rejects out-of-range hours', async () => {
      const tooBig = await app.inject({ method: 'GET', url: '/v2/actor-runs/histogram?hours=999' });
      expect(tooBig.statusCode).toBe(500); // Zod parse throws → Fastify 500 by default

      const zero = await app.inject({ method: 'GET', url: '/v2/actor-runs/histogram?hours=0' });
      expect(zero.statusCode).toBe(500);
    });
  });

  describe('GET /v2/actor-runs/:runId', () => {
    it('should get run by id', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow()],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs/run-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('run-1');
      expect(body.data.status).toBe('RUNNING');
    });

    it('should return 404 for non-existent run', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs/non-existent',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /v2/actor-runs/:runId', () => {
    it('should update run status', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'SUCCEEDED', finished_at: new Date() })],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/actor-runs/run-1',
        payload: { status: 'SUCCEEDED' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('SUCCEEDED');
    });

    it('should update status message', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status_message: 'Processing page 5/10' })],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/actor-runs/run-1',
        payload: { statusMessage: 'Processing page 5/10' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns defaultDatasetItemCount on the updated run (C1 regression — CTE preserves the LEFT JOIN)', async () => {
      // Symmetric with the abort + resurrect regression tests below.
      // Non-zero distinct value (1247) — using the factory default of
      // 0 would let "JOIN dropped, field is undefined → ?? 0 → 0"
      // silently pass. 1247 forces the assertion to actually exercise
      // the joined column.
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'SUCCEEDED', default_dataset_item_count: 1247 })],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/v2/actor-runs/run-1',
        payload: { status: 'SUCCEEDED' },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.defaultDatasetItemCount).toBe(1247);
      expect(body.data.stats.datasetItemCount).toBe(1247);
    });
  });

  describe('POST /v2/actor-runs/:runId/abort', () => {
    it('should abort running actor', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'ABORTED', finished_at: new Date() })],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/abort',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('ABORTED');
    });

    it('should return 404 if run not found or already finished', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/non-existent/abort',
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns defaultDatasetItemCount on the aborted run (C1 regression — CTE preserves the LEFT JOIN)', async () => {
      // Pre-CTE-rewrite, abort/resurrect/PUT used RETURNING * directly
      // and skipped the LEFT JOIN datasets, so the response payload had
      // `defaultDatasetItemCount: undefined`. The CTE pattern keeps the
      // shape identical to list/GET. Asserting per-endpoint here so the
      // regression class is permanently caught.
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'ABORTED', default_dataset_item_count: 42 })],
      });

      const response = await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/abort' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.defaultDatasetItemCount).toBe(42);
      expect(body.data.stats.datasetItemCount).toBe(42);
    });

    it('publishes run:abort so the owning runner stops the container', async () => {
      // Without this signal the container keeps crawling until it exits
      // on its own or hits timeout_secs (default 3600s) — the runner's
      // heartbeat keeps claiming the run and blocks scale-down for up to
      // an extra hour after the operator aborted.
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'ABORTED', finished_at: new Date() })],
      });

      await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/abort' });

      expect(mockPublish).toHaveBeenCalledWith('run:abort', 'run-1');
    });

    it('does not publish run:abort when the run was not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await app.inject({ method: 'POST', url: '/v2/actor-runs/missing/abort' });

      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('POST /v2/actor-runs/:runId/resurrect', () => {
    it('resurrects to READY so a runner can claim it (RUNNING would orphan it forever)', async () => {
      // Runners claim exclusively `WHERE status = 'READY'` (see
      // packages/runner/src/queue.ts processNextRun). Resurrecting
      // straight to RUNNING left the run permanently unclaimed AND
      // unreapable (finished_at = NULL exempts it from retention).
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'READY', finished_at: null })],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/resurrect',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.status).toBe('READY');

      const sql = (mockQuery.mock.calls[0]?.[0] as string) ?? '';
      expect(sql).toContain("status = 'READY'");
      expect(sql).not.toContain("SET status = 'RUNNING'");
      // The new attempt must not carry the failed attempt's exit code /
      // error message while it waits to run.
      expect(sql).toContain('exit_code = NULL');
      expect(sql).toContain('status_message = NULL');
      // ...nor the failed attempt's start time: leaving started_at made
      // re-queued runs display a stale "started" while READY. The claim
      // re-stamps it (queue.ts SET started_at = NOW()).
      expect(sql).toContain('started_at = NULL');
    });

    it('publishes run:new so runners pick the resurrected run up immediately', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'READY', finished_at: null })],
      });

      await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/resurrect' });

      expect(mockPublish).toHaveBeenCalledWith('run:new', 'run-1');
    });

    it('does not publish when the run was not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/missing/resurrect',
      });

      expect(response.statusCode).toBe(404);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('returns defaultDatasetItemCount on the resurrected run (C1 regression — CTE preserves the LEFT JOIN)', async () => {
      // Symmetric with the abort + PUT regression tests. Non-zero
      // distinct value (88) so "JOIN dropped → undefined → ?? 0 → 0"
      // cannot silently satisfy the assertion.
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow({ status: 'READY', default_dataset_item_count: 88 })],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/resurrect',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.defaultDatasetItemCount).toBe(88);
      expect(body.data.stats.datasetItemCount).toBe(88);
    });
  });

  describe('POST /v2/actor-runs/:runId/rerun', () => {
    // Rerun creates a brand-NEW run (fresh id + storages) instead of
    // re-queuing the origin row like resurrect does. The distinction is
    // load-bearing for webhook consumers: deliveries are keyed by run id
    // downstream (e.g. a consumer with a UNIQUE constraint on it), so a
    // resurrected run's second terminal webhook can be dropped as a
    // duplicate. A fresh id sidesteps that entirely.
    const originRow = (overrides = {}) =>
      createRunRow({
        id: 'run-1',
        status: 'FAILED',
        user_id: 'test-user-id',
        timeout_secs: 7200,
        memory_mbytes: 2048,
        ...overrides,
      });

    const newRunRow = (overrides = {}) =>
      createRunRow({
        id: 'new-run-id',
        status: 'READY',
        origin_run_id: 'run-1',
        timeout_secs: 7200,
        memory_mbytes: 2048,
        started_at: null,
        default_dataset_item_count: null,
        ...overrides,
      });

    /**
     * Queue the happy-path query sequence. Order mirrors the handler:
     * origin lookup → advisory xact lock → active-clone check →
     * dataset/kv/queue INSERTs → build lookup → run INSERT (CTE) →
     * per-run webhooks SELECT → one INSERT per webhook.
     * (BEGIN/COMMIT/ROLLBACK never consume slots — see the client mock.)
     */
    function mockRerunQueries({
      webhookRows = [] as Array<Record<string, unknown>>,
      insertedRun = newRunRow(),
    } = {}) {
      mockQuery
        .mockResolvedValueOnce({ rows: [originRow()] })
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_xact_lock
        .mockResolvedValueOnce({ rows: [] }) // active-clone check: none
        .mockResolvedValueOnce({ rows: [] }) // INSERT dataset
        .mockResolvedValueOnce({ rows: [] }) // INSERT kv store
        .mockResolvedValueOnce({ rows: [] }) // INSERT request queue
        .mockResolvedValueOnce({ rows: [{ build_id: 'b-2', version_number: '1.0.1' }] })
        .mockResolvedValueOnce({ rows: [insertedRun] })
        .mockResolvedValueOnce({ rows: webhookRows });
      for (let i = 0; i < webhookRows.length; i++) {
        mockQuery.mockResolvedValueOnce({ rows: [] });
      }
    }

    async function mockInputRecord(json = '{"startUrls":["https://example.com"]}') {
      const { getKVRecord } = await import('../src/storage/s3.js');
      (getKVRecord as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        value: Buffer.from(json),
        contentType: 'application/json',
      });
    }

    beforeEach(async () => {
      const { getKVRecord, putKVRecord } = await import('../src/storage/s3.js');
      (getKVRecord as ReturnType<typeof vi.fn>).mockClear();
      (putKVRecord as ReturnType<typeof vi.fn>).mockClear();
      mockRedisGet.mockClear().mockResolvedValue(null);
      mockRedisSet.mockClear();
    });

    it('creates a NEW run (201) with fresh storages, copied INPUT bytes, and copied options', async () => {
      await mockInputRecord('{"foo":1}');
      mockRerunQueries();

      const response = await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('new-run-id');
      expect(body.data.status).toBe('READY');
      expect(body.data.originRunId).toBe('run-1');

      // Origin lookup must be user-scoped AND terminal-status-guarded.
      const originSql = (mockQuery.mock.calls[0]?.[0] as string) ?? '';
      expect(originSql).toContain("'FAILED'");
      expect(originSql).toContain("'ABORTED'");
      expect(originSql).toContain("'TIMED-OUT'");
      expect(originSql).toContain('user_id');

      // Serialization: xact advisory lock on the chain root, then a
      // race-free active-clone check — both on the transaction client.
      expect(mockQuery.mock.calls[1]?.[0] as string).toContain('pg_advisory_xact_lock');
      expect(mockQuery.mock.calls[1]?.[1]).toEqual(['run-1']);
      const activeCheckSql = (mockQuery.mock.calls[2]?.[0] as string) ?? '';
      expect(activeCheckSql).toContain('origin_run_id');
      expect(activeCheckSql).toContain('user_id');
      expect(txStatements).toEqual(['BEGIN', 'COMMIT']);

      // INPUT is copied byte-for-byte into the NEW kv store, not the origin's.
      const { putKVRecord } = await import('../src/storage/s3.js');
      const putCall = (putKVRecord as ReturnType<typeof vi.fn>).mock.calls[0];
      const kvInsertParams = mockQuery.mock.calls[4]?.[1] as unknown[];
      expect(putCall[0]).toBe(kvInsertParams[0]); // freshly created store
      expect(putCall[0]).not.toBe('kv-1'); // never the origin's store
      expect(putCall[1]).toBe('INPUT');
      expect(Buffer.isBuffer(putCall[2]) ? putCall[2].toString() : putCall[2]).toBe('{"foo":1}');
      expect(putCall[3]).toBe('application/json');

      // Run INSERT carries the origin's options, the fresh build, and lineage.
      const runInsertParams = mockQuery.mock.calls[7]?.[1] as unknown[];
      expect(runInsertParams).toContain(7200);
      expect(runInsertParams).toContain(2048);
      expect(runInsertParams).toContain('b-2');
      expect(runInsertParams).toContain('1.0.1');
      expect(runInsertParams).toContain('run-1'); // origin_run_id

      // The origin row is never mutated — its failure history must survive.
      for (const call of mockQuery.mock.calls) {
        expect(call[0] as string).not.toMatch(/UPDATE\s+runs/i);
      }
    });

    it('collapses lineage chains: rerunning a rerun points at the ORIGINAL run', async () => {
      // Same convention as the runner's retry path — origin_run_id always
      // names the first run in the chain, never the immediate parent, so
      // the UI can link "rerun of X" without walking a chain.
      await mockInputRecord();
      mockQuery
        .mockResolvedValueOnce({ rows: [originRow({ origin_run_id: 'run-0' })] })
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [] }) // active-clone check
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ build_id: 'b-2', version_number: '1.0.1' }] })
        .mockResolvedValueOnce({ rows: [newRunRow({ origin_run_id: 'run-0' })] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      expect(response.statusCode).toBe(201);
      // The lock and the active-clone check both key on the chain ROOT,
      // not the immediate parent — same collapsing as the insert.
      expect(mockQuery.mock.calls[1]?.[1]).toEqual(['run-0']);
      expect(mockQuery.mock.calls[2]?.[1]).toEqual(['run-0', 'test-user-id']);
      // The check must cover the root row itself, not just its clones —
      // a resurrected root is active with no origin_run_id pointing at it.
      expect(mockQuery.mock.calls[2]?.[0] as string).toMatch(/origin_run_id = \$1 OR id = \$1/);
      const runInsertParams = mockQuery.mock.calls[7]?.[1] as unknown[];
      expect(runInsertParams).toContain('run-0');
      expect(runInsertParams).not.toContain('run-1');
    });

    it('returns 404 (and creates nothing) when the run is missing, foreign, or not terminal', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error.type).toBe('record-not-found');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockPublish).not.toHaveBeenCalled();
      const { putKVRecord } = await import('../src/storage/s3.js');
      expect(putKVRecord).not.toHaveBeenCalled();
    });

    it('returns 409 (and creates nothing) when the origin INPUT record no longer exists', async () => {
      // Retention reaps unnamed storages independently of runs; a rerun
      // with a silently-empty input would "succeed" and scrape nothing.
      // Fail loudly instead.
      mockQuery.mockResolvedValueOnce({ rows: [originRow()] });
      // getKVRecord default mock resolves null — exactly the reaped case.

      const response = await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error.type).toBe('input-not-found');
      expect(mockQuery).toHaveBeenCalledTimes(1); // no storage/run INSERTs
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('returns 409 rerun-already-active when a clone of the chain is already queued or running', async () => {
      // Concurrent POSTs (double click, two tabs, retried request, bulk
      // overlap) must produce exactly one clone. The advisory lock
      // serializes them; the loser sees the winner's committed READY row
      // here and bails before creating anything.
      await mockInputRecord();
      mockQuery
        .mockResolvedValueOnce({ rows: [originRow()] })
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [{ found: 1 }] }); // active clone exists

      const response = await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error.type).toBe('rerun-already-active');
      expect(mockQuery).toHaveBeenCalledTimes(3); // no storage/run/webhook writes
      const { putKVRecord } = await import('../src/storage/s3.js');
      expect(putKVRecord).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
      expect(txStatements).toEqual(['BEGIN', 'ROLLBACK']);
      expect(mockRelease).toHaveBeenCalled();
    });

    it('rolls back the whole clone when a mid-transaction write fails', async () => {
      // All-or-nothing is load-bearing: a run row committed without its
      // webhook clones could be claimed by the runner's poll loop and
      // finish silently — the exact failure mode rerun exists to fix.
      await mockInputRecord();
      mockQuery
        .mockResolvedValueOnce({ rows: [originRow()] })
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [] }) // active-clone check
        .mockResolvedValueOnce({ rows: [] }) // INSERT dataset
        .mockResolvedValueOnce({ rows: [] }) // INSERT kv store
        .mockResolvedValueOnce({ rows: [] }) // INSERT request queue
        .mockResolvedValueOnce({ rows: [{ build_id: 'b-2', version_number: '1.0.1' }] })
        .mockRejectedValueOnce(new Error('run INSERT blew up'));

      const response = await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      expect(response.statusCode).toBe(500);
      expect(txStatements).toEqual(['BEGIN', 'ROLLBACK']);
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalled();
    });

    it('copies per-run webhooks onto the new run id', async () => {
      // THE reason rerun exists (vs resurrect): consumers are notified
      // under a fresh run id. Skipping the copy would make the new run
      // finish silently — same latent bug the runner's auto-retry has.
      await mockInputRecord();
      mockRerunQueries({
        webhookRows: [
          {
            id: 'wh-1',
            user_id: 'test-user-id',
            event_types: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED'],
            request_url: 'https://consumer.example.com/hook',
            payload_template: '{"locale":"cl"}',
            headers: { Authorization: 'Bearer secret' },
            is_enabled: true,
          },
        ],
      });

      const response = await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });
      expect(response.statusCode).toBe(201);

      // Webhook SELECT is scoped to the origin run AND the caller — the
      // clone must never be able to copy another tenant's webhook.
      const whSelect = mockQuery.mock.calls[8];
      expect(whSelect[0] as string).toMatch(/FROM webhooks/i);
      expect(whSelect[0] as string).toContain('user_id');
      expect(whSelect[1] as unknown[]).toEqual(['run-1', 'test-user-id']);

      // The copy INSERT targets the NEW run id with a fresh webhook id.
      const newRunId = (mockQuery.mock.calls[7]?.[1] as unknown[])[0];
      const whInsert = mockQuery.mock.calls[9];
      expect(whInsert[0] as string).toMatch(/INSERT INTO webhooks/i);
      const whParams = whInsert[1] as unknown[];
      expect(whParams).toContain(newRunId);
      expect(whParams).not.toContain('wh-1');
      expect(whParams).toContain('https://consumer.example.com/hook');
      expect(whParams).toContain('{"locale":"cl"}');
    });

    it('publishes run:new with the NEW run id, never the origin id', async () => {
      await mockInputRecord();
      mockRerunQueries();

      await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      const newRunId = (mockQuery.mock.calls[7]?.[1] as unknown[])[0];
      expect(mockPublish).toHaveBeenCalledWith('run:new', newRunId);
      expect(mockPublish).not.toHaveBeenCalledWith('run:new', 'run-1');
    });

    it('copies the origin envVars Redis key to the new run when present', async () => {
      await mockInputRecord();
      mockRerunQueries();
      mockRedisGet.mockResolvedValueOnce('{"PROXY_PASSWORD":"x"}');

      await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      const newRunId = (mockQuery.mock.calls[7]?.[1] as unknown[])[0] as string;
      expect(mockRedisGet).toHaveBeenCalledWith('run:run-1:envVars');
      expect(mockRedisSet).toHaveBeenCalledWith(
        `run:${newRunId}:envVars`,
        '{"PROXY_PASSWORD":"x"}',
        'EX',
        86400
      );
    });

    it('skips the envVars copy when the origin key expired', async () => {
      await mockInputRecord();
      mockRerunQueries();

      await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('returns defaultDatasetItemCount via the formatRun contract (fresh dataset → null count)', async () => {
      await mockInputRecord();
      mockRerunQueries();

      const response = await app.inject({ method: 'POST', url: '/v2/actor-runs/run-1/rerun' });

      const body = JSON.parse(response.body);
      expect(body.data).toHaveProperty('defaultDatasetItemCount');
      expect(body.data.stats).toHaveProperty('datasetItemCount');
    });
  });

  describe('GET /v2/actor-runs/:runId/dataset/items', () => {
    it('should get dataset items for run', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createRunRow()],
      });

      const { listDatasetItems } = await import('../src/storage/s3.js');
      (listDatasetItems as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        items: [{ url: 'https://example.com' }],
        total: 1,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs/run-1/dataset/items',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
    });
  });

  describe('POST /v2/actor-runs/:runId/ingest-crawler-stats', () => {
    // Locks the SDK file → stats_json normalization. Receivers reading
    // resource.stats from webhook payloads rely on the field names we
    // pick here.

    it('returns stats:null and does not UPDATE when SDK_CRAWLER_STATISTICS_0 is missing', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'run-1', default_key_value_store_id: 'kv-1', user_id: 'test-user-id' }],
      });
      const s3 = await import('../src/storage/s3.js');
      vi.mocked(s3.getKVRecord).mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/ingest-crawler-stats',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.stats).toBeNull();
      // Only one query ran (the run-lookup); the UPDATE didn't fire.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('parses SDK file and writes a normalized stats_json on UPDATE', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'run-1', default_key_value_store_id: 'kv-1', user_id: 'test-user-id' }],
        })
        .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE

      const sdkPayload = {
        requestsFinished: 42,
        requestsFailed: 3,
        requestsTotal: 45,
        requestsRetries: 7,
        crawlerRuntimeMillis: 38176,
        crawlerStartedAt: '2026-05-02T11:24:55.000Z',
        crawlerFinishedAt: '2026-05-02T11:25:33.000Z',
      };
      const s3 = await import('../src/storage/s3.js');
      vi.mocked(s3.getKVRecord).mockResolvedValueOnce({
        value: Buffer.from(JSON.stringify(sdkPayload), 'utf8'),
        contentType: 'application/json',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/ingest-crawler-stats',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // Apify-compat fields the existing webhook payload already promised
      expect(body.data.stats).toMatchObject({
        runTimeSecs: 38, // 38176 ms → 38 s
        computeUnits: 0,
        inputBodyLen: 0,
      });
      // Crawlee extension — receivers reading these get the rich picture
      expect(body.data.stats).toMatchObject({
        requestsFinished: 42,
        requestsFailed: 3,
        requestsTotal: 45,
        requestsRetries: 7,
        crawlerRuntimeMillis: 38176,
        crawlerStartedAt: '2026-05-02T11:24:55.000Z',
        crawlerFinishedAt: '2026-05-02T11:25:33.000Z',
      });
      // UPDATE was called with the normalized stats
      const updateCall = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateCall[0]).toMatch(/UPDATE runs SET stats_json/);
      expect((updateCall[1][0] as Record<string, number>).requestsFailed).toBe(3);
    });

    it('rejects malformed SDK JSON with 422 — does not silently corrupt stats_json', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'run-1', default_key_value_store_id: 'kv-1', user_id: 'test-user-id' }],
      });
      const s3 = await import('../src/storage/s3.js');
      vi.mocked(s3.getKVRecord).mockResolvedValueOnce({
        value: Buffer.from('not json{{{', 'utf8'),
        contentType: 'application/json',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/run-1/ingest-crawler-stats',
        payload: {},
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('invalid-stats');
    });

    it('returns 404 when the run is not owned by the caller', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership check fails

      const response = await app.inject({
        method: 'POST',
        url: '/v2/actor-runs/foreign/ingest-crawler-stats',
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /v2/actor-runs/:runId/cost', () => {
    const T0 = new Date('2026-07-15T10:00:00Z');
    const hoursAfter = (h: number) => new Date(T0.getTime() + h * 3_600_000);

    const costRow = (overrides = {}) => ({
      id: 'run-1',
      status: 'SUCCEEDED',
      started_at: T0,
      finished_at: hoursAfter(2),
      memory_mbytes: 1024,
      runner_id: 'droplet-123',
      // pg returns NUMERIC as a string — the route must parseFloat
      runner_price_hourly: '0.10',
      runner_provider: 'digitalocean',
      default_dataset_item_count: 1000,
      ...overrides,
    });

    it('computes overlap cost, apify estimate, and per-1k rates', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [costRow()] })
        // one sibling sharing the whole 2h window → cost splits in half.
        // Keys are camelCase because the sibling query aliases the columns
        // (`started_at AS "startedAt"`) — the mock mirrors the SQL contract.
        .mockResolvedValueOnce({ rows: [{ startedAt: T0, finishedAt: hoursAfter(2) }] });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/run-1/cost' });

      expect(response.statusCode).toBe(200);
      const { data } = JSON.parse(response.body);
      // 2h × $0.10/hr ÷ 2 runs = $0.10
      expect(data.yourCostUsd).toBeCloseTo(0.1, 6);
      // 1 GB × 2 h × $0.40 = $0.80
      expect(data.apifyCostUsd).toBeCloseTo(0.8, 6);
      expect(data.savingsPct).toBeCloseTo(87.5, 1);
      expect(data.itemCount).toBe(1000);
      expect(data.yourCostPer1kItems).toBeCloseTo(0.1, 6);
      expect(data.apifyCostPer1kItems).toBeCloseTo(0.8, 6);
      expect(data.inputs.overlappingRuns).toBe(1);
      expect(data.inputs.runnerPriceHourly).toBeCloseTo(0.1, 6);
    });

    it('returns yourCostUsd 0 for local-docker runs without querying siblings', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [costRow({ runner_provider: 'local-docker', runner_price_hourly: null })],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/run-1/cost' });

      expect(response.statusCode).toBe(200);
      const { data } = JSON.parse(response.body);
      expect(data.yourCostUsd).toBe(0);
      expect(data.apifyCostUsd).toBeCloseTo(0.8, 6);
      // no second (sibling) query for local runs
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('returns yourCostUsd null when attribution was never recorded', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [costRow({ runner_id: null, runner_price_hourly: null, runner_provider: null })],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/run-1/cost' });

      expect(response.statusCode).toBe(200);
      const { data } = JSON.parse(response.body);
      expect(data.yourCostUsd).toBeNull();
      expect(data.savingsPct).toBeNull();
      expect(data.yourCostPer1kItems).toBeNull();
      expect(data.apifyCostUsd).toBeCloseTo(0.8, 6);
    });

    it('omits per-1k rates when the run produced no items', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [costRow({ default_dataset_item_count: 0 })] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/run-1/cost' });

      const { data } = JSON.parse(response.body);
      expect(data.yourCostPer1kItems).toBeNull();
      expect(data.apifyCostPer1kItems).toBeNull();
    });

    it('clamps negative durations (clock skew) to zero cost instead of negative', async () => {
      // finished_at precedes started_at: runner-clock finish vs DB-clock start
      mockQuery
        .mockResolvedValueOnce({
          rows: [costRow({ started_at: hoursAfter(1), finished_at: T0 })],
        })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/run-1/cost' });

      expect(response.statusCode).toBe(200);
      const { data } = JSON.parse(response.body);
      expect(data.apifyCostUsd).toBe(0);
      expect(data.inputs.durationHours).toBe(0);
      expect(data.inputs.computeUnits).toBe(0);
    });

    it('rejects non-terminal runs with 400 run-not-finished', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [costRow({ status: 'RUNNING', finished_at: null })],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/run-1/cost' });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.type).toBe('run-not-finished');
    });

    it('returns 404 for an unknown run', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/run-nope/cost' });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /v2/actor-runs/costs (batch)', () => {
    const T0 = new Date('2026-07-15T10:00:00Z');
    const hoursAfter = (h: number) => new Date(T0.getTime() + h * 3_600_000);

    // Shape of the batch endpoint's run query — narrower than the single
    // endpoint's costRow (no memory/items: the batch returns yourCostUsd only).
    const batchRow = (overrides = {}) => ({
      id: 'run-1',
      started_at: T0,
      finished_at: hoursAfter(2),
      runner_id: 'droplet-123',
      runner_price_hourly: '0.10',
      runner_provider: 'digitalocean',
      ...overrides,
    });

    it('computes costs for a mixed batch in two queries, omitting unknown ids', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            batchRow(),
            batchRow({
              id: 'run-2',
              runner_provider: 'local-docker',
              runner_id: null,
              runner_price_hourly: null,
            }),
            batchRow({
              id: 'run-3',
              runner_id: null,
              runner_price_hourly: null,
              runner_provider: null,
            }),
          ],
        })
        // Sibling query covers only run-1 (the sole droplet-attributed run):
        // one sibling spanning the whole 2h window → cost splits in half.
        .mockResolvedValueOnce({
          rows: [{ targetId: 'run-1', startedAt: T0, finishedAt: hoursAfter(2) }],
        });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs/costs?ids=run-1,run-2,run-3,run-nope',
      });

      expect(response.statusCode).toBe(200);
      const { costs } = JSON.parse(response.body).data;
      // 2h × $0.10/hr ÷ 2 runs = $0.10 — must match the single-run endpoint.
      expect(costs['run-1'].yourCostUsd).toBeCloseTo(0.1, 6);
      expect(costs['run-2'].yourCostUsd).toBe(0); // self-hosted
      expect(costs['run-3'].yourCostUsd).toBeNull(); // never recorded
      expect(costs['run-nope']).toBeUndefined(); // silently omitted
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('skips the sibling query when no run in the batch is droplet-attributed', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          batchRow({
            runner_provider: 'local-docker',
            runner_id: null,
            runner_price_hourly: null,
          }),
        ],
      });

      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/costs?ids=run-1' });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).data.costs['run-1'].yourCostUsd).toBe(0);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('omits non-terminal runs (the SQL filter) — mirrored here as an empty result', async () => {
      // The status filter lives in SQL; a RUNNING id simply comes back rowless.
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs/costs?ids=run-running',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).data.costs).toEqual({});
    });

    it('returns an empty map without querying when ids is empty', async () => {
      const response = await app.inject({ method: 'GET', url: '/v2/actor-runs/costs' });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).data.costs).toEqual({});
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('handles repeated ids params (?ids=a&ids=b) instead of 500ing', async () => {
      // Fastify's default query parser turns repeated params into an array.
      // local-docker row → no sibling query, so a single mock suffices.
      mockQuery.mockResolvedValueOnce({
        rows: [
          batchRow({ runner_provider: 'local-docker', runner_id: null, runner_price_hourly: null }),
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v2/actor-runs/costs?ids=run-1&ids=run-2',
      });

      expect(response.statusCode).toBe(200);
      // Both ids reached the SQL as one deduped list.
      expect(mockQuery.mock.calls[0]?.[1]?.[0]).toEqual(['run-1', 'run-2']);
    });

    it('rejects more than 50 ids with 400', async () => {
      const ids = Array.from({ length: 51 }, (_, i) => `run-${i}`).join(',');

      const response = await app.inject({ method: 'GET', url: `/v2/actor-runs/costs?ids=${ids}` });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.type).toBe('invalid-request');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
