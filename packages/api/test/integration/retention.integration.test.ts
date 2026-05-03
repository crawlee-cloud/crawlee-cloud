/**
 * Retention reaper integration tests — exercise real PG + MinIO via the
 * shared integration setup. Slice #3.
 *
 * The shared beforeAll initialises the API's module-level pool/redis/s3
 * (NOT a separate local pool) so that code under test like runReaperTick(),
 * which imports `pool` from db/index.js, sees the same connection pool
 * the tests use for direct setup queries.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type pg from 'pg';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { TEST_CONFIG, ensureS3Bucket, runMigrations } from './setup.js';

// Bound in beforeAll to the API's module-level pool — see comment above.
let pool: pg.Pool;

beforeAll(async () => {
  // Mirror the env mutations createTestApp() does, so module imports below
  // pick up test config rather than dev defaults.
  process.env.DATABASE_URL = TEST_CONFIG.databaseUrl;
  process.env.REDIS_URL = TEST_CONFIG.redisUrl;
  process.env.S3_ENDPOINT = TEST_CONFIG.s3Endpoint;
  process.env.S3_ACCESS_KEY = TEST_CONFIG.s3AccessKey;
  process.env.S3_SECRET_KEY = TEST_CONFIG.s3SecretKey;
  process.env.S3_BUCKET = TEST_CONFIG.s3Bucket;
  process.env.S3_REGION = TEST_CONFIG.s3Region;
  process.env.S3_FORCE_PATH_STYLE = 'true';
  process.env.API_SECRET = TEST_CONFIG.apiSecret;
  process.env.NODE_ENV = 'test';

  await ensureS3Bucket();
  const { initDatabase } = await import('../../src/db/index.js');
  const { initS3 } = await import('../../src/storage/s3.js');
  const { initRedis } = await import('../../src/storage/redis.js');
  await initDatabase();
  await initS3();
  await initRedis();
  await runMigrations();
  // Re-import after init so the bound `pool` symbol is the populated one.
  pool = (await import('../../src/db/index.js')).pool;

  // Fixture actor — runs.actor_id has a FK to actors(id), so reapRuns and
  // orchestration tests insert runs with actor_id='ret-test-actor' and need
  // the parent row present. ON CONFLICT keeps it idempotent across re-runs.
  await pool.query(
    `INSERT INTO actors (id, name, user_id)
     VALUES ('ret-test-actor', 'retention-test-actor', 'ret-test-user')
     ON CONFLICT (id) DO NOTHING`
  );
});

afterAll(async () => {
  // Pool is owned by the API module — don't end() it here; the test runner
  // teardown closes connections.
});

describe('retention schema — tombstones', () => {
  it('retention_tombstones table exists with the expected columns', async () => {
    const result = await pool.query(`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_name = 'retention_tombstones'
       ORDER BY ordinal_position
    `);
    const cols = result.rows.map((r) => r.column_name);
    expect(cols).toEqual([
      'id',
      'resource_kind',
      'resource_id',
      'resource_name',
      'user_id',
      'reason',
      'original_created_at',
      'metadata',
      'deleted_at',
    ]);
  });

  it('CHECK constraint on resource_kind rejects unknown values', async () => {
    await expect(
      pool.query(
        `INSERT INTO retention_tombstones (resource_kind, resource_id, reason)
         VALUES ('not-a-kind', 'fakeid', 'expired-unnamed')`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('CHECK constraint on reason rejects unknown values', async () => {
    await expect(
      pool.query(
        `INSERT INTO retention_tombstones (resource_kind, resource_id, reason)
         VALUES ('dataset', 'fakeid', 'made-up-reason')`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('valid insert with metadata JSONB succeeds', async () => {
    const result = await pool.query<{ metadata: { actor_id: string } }>(
      `INSERT INTO retention_tombstones
         (resource_kind, resource_id, user_id, reason, metadata)
       VALUES ('run', 'r123', 'u456', 'expired-run',
               jsonb_build_object('actor_id', 'a789', 'status', 'SUCCEEDED'))
       RETURNING metadata`
    );
    expect(result.rows[0]?.metadata).toEqual({ actor_id: 'a789', status: 'SUCCEEDED' });
    // Cleanup
    await pool.query(`DELETE FROM retention_tombstones WHERE resource_id = 'r123'`);
  });
});

describe('retention schema — FK softening', () => {
  it('deleting a dataset that a run references nulls the FK rather than failing', async () => {
    const dsId = 'fk-test-ds-' + Math.random().toString(36).slice(2, 10);
    const runId = 'fk-test-run-' + Math.random().toString(36).slice(2, 10);
    const userId = 'fk-test-user';

    await pool.query(`INSERT INTO datasets (id, name, user_id) VALUES ($1, $2, $3)`, [
      dsId,
      dsId,
      userId,
    ]);
    await pool.query(`INSERT INTO runs (id, user_id, default_dataset_id) VALUES ($1, $2, $3)`, [
      runId,
      userId,
      dsId,
    ]);

    // Pre-fix: this DELETE would error with foreign_key_violation.
    // Post-fix: it succeeds and the run's default_dataset_id becomes NULL.
    await pool.query(`DELETE FROM datasets WHERE id = $1`, [dsId]);

    const result = await pool.query<{ default_dataset_id: string | null }>(
      `SELECT default_dataset_id FROM runs WHERE id = $1`,
      [runId]
    );
    expect(result.rows[0]?.default_dataset_id).toBeNull();

    // Cleanup
    await pool.query(`DELETE FROM runs WHERE id = $1`, [runId]);
  });

  it('deleting a key_value_store that a run references nulls the FK rather than failing', async () => {
    const kvId = 'fk-test-kv-' + Math.random().toString(36).slice(2, 10);
    const runId = 'fk-test-run-' + Math.random().toString(36).slice(2, 10);
    const userId = 'fk-test-user';

    await pool.query(`INSERT INTO key_value_stores (id, name, user_id) VALUES ($1, $2, $3)`, [
      kvId,
      kvId,
      userId,
    ]);
    await pool.query(
      `INSERT INTO runs (id, user_id, default_key_value_store_id) VALUES ($1, $2, $3)`,
      [runId, userId, kvId]
    );

    // Pre-fix: this DELETE would error with foreign_key_violation.
    // Post-fix: it succeeds and the run's default_key_value_store_id becomes NULL.
    await pool.query(`DELETE FROM key_value_stores WHERE id = $1`, [kvId]);

    const result = await pool.query<{ default_key_value_store_id: string | null }>(
      `SELECT default_key_value_store_id FROM runs WHERE id = $1`,
      [runId]
    );
    expect(result.rows[0]?.default_key_value_store_id).toBeNull();

    // Cleanup
    await pool.query(`DELETE FROM runs WHERE id = $1`, [runId]);
  });

  it('deleting a request_queue that a run references nulls the FK rather than failing', async () => {
    const qId = 'fk-test-rq-' + Math.random().toString(36).slice(2, 10);
    const runId = 'fk-test-run-' + Math.random().toString(36).slice(2, 10);
    const userId = 'fk-test-user';

    await pool.query(`INSERT INTO request_queues (id, name, user_id) VALUES ($1, $2, $3)`, [
      qId,
      qId,
      userId,
    ]);
    await pool.query(
      `INSERT INTO runs (id, user_id, default_request_queue_id) VALUES ($1, $2, $3)`,
      [runId, userId, qId]
    );

    // Pre-fix: this DELETE would error with foreign_key_violation.
    // Post-fix: it succeeds and the run's default_request_queue_id becomes NULL.
    await pool.query(`DELETE FROM request_queues WHERE id = $1`, [qId]);

    const result = await pool.query<{ default_request_queue_id: string | null }>(
      `SELECT default_request_queue_id FROM runs WHERE id = $1`,
      [runId]
    );
    expect(result.rows[0]?.default_request_queue_id).toBeNull();

    // Cleanup
    await pool.query(`DELETE FROM runs WHERE id = $1`, [runId]);
  });
});

describe('retention schema — sweep indexes', () => {
  it('all four reaper sweep indexes exist with correct partial predicates', async () => {
    const result = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE indexname IN (
          'idx_datasets_unnamed_accessed',
          'idx_kv_stores_unnamed_accessed',
          'idx_request_queues_unnamed_accessed',
          'idx_runs_finished'
        )
        ORDER BY indexname`
    );
    expect(result.rows).toHaveLength(4);
    // Alphabetical ORDER BY indexname:
    //   [0] idx_datasets_unnamed_accessed         WHERE name IS NULL
    //   [1] idx_kv_stores_unnamed_accessed        WHERE name IS NULL
    //   [2] idx_request_queues_unnamed_accessed   WHERE name IS NULL
    //   [3] idx_runs_finished                     WHERE finished_at IS NOT NULL
    expect(result.rows[0]?.indexdef).toMatch(/WHERE \(?name IS NULL\)?/);
    expect(result.rows[1]?.indexdef).toMatch(/WHERE \(?name IS NULL\)?/);
    expect(result.rows[2]?.indexdef).toMatch(/WHERE \(?name IS NULL\)?/);
    expect(result.rows[3]?.indexdef).toMatch(/WHERE \(?finished_at IS NOT NULL\)?/);
  });
});

describe('s3 prefix helpers', () => {
  let s3: S3Client;

  beforeAll(() => {
    s3 = new S3Client({
      endpoint: TEST_CONFIG.s3Endpoint,
      region: TEST_CONFIG.s3Region,
      credentials: {
        accessKeyId: TEST_CONFIG.s3AccessKey,
        secretAccessKey: TEST_CONFIG.s3SecretKey,
      },
      forcePathStyle: true,
    });
  });

  it('deleteDatasetS3Prefix removes every object under the dataset prefix', async () => {
    const dsId = 'pref-test-' + Math.random().toString(36).slice(2, 10);
    // Seed three objects under the prefix.
    for (let i = 0; i < 3; i++) {
      await s3.send(
        new PutObjectCommand({
          Bucket: TEST_CONFIG.s3Bucket,
          Key: `datasets/${dsId}/000000${i}00.batch.json`,
          Body: JSON.stringify([{ idx: i }]),
        })
      );
    }
    // Verify they're there.
    const before = await s3.send(
      new ListObjectsV2Command({ Bucket: TEST_CONFIG.s3Bucket, Prefix: `datasets/${dsId}/` })
    );
    expect(before.Contents?.length ?? 0).toBe(3);

    // Call the helper under test. (initS3 was already called by the shared
    // beforeAll, so the module-level s3 client is wired up.)
    const { deleteDatasetS3Prefix } = await import('../../src/storage/s3.js');
    await deleteDatasetS3Prefix(dsId);

    // Verify all gone.
    const after = await s3.send(
      new ListObjectsV2Command({ Bucket: TEST_CONFIG.s3Bucket, Prefix: `datasets/${dsId}/` })
    );
    expect(after.Contents ?? []).toHaveLength(0);
  });

  it('deleteDatasetS3Prefix is a no-op for an empty prefix', async () => {
    const { deleteDatasetS3Prefix } = await import('../../src/storage/s3.js');
    // Should not throw.
    await deleteDatasetS3Prefix('non-existent-' + Math.random().toString(36).slice(2));
  });

  it('deleteKVStoreS3Prefix removes every record under the KV store prefix', async () => {
    const kvId = 'pref-test-kv-' + Math.random().toString(36).slice(2, 10);
    for (const k of ['foo', 'bar', 'baz']) {
      await s3.send(
        new PutObjectCommand({
          Bucket: TEST_CONFIG.s3Bucket,
          Key: `key-value-stores/${kvId}/${encodeURIComponent(k)}`,
          Body: 'value',
        })
      );
    }
    const before = await s3.send(
      new ListObjectsV2Command({
        Bucket: TEST_CONFIG.s3Bucket,
        Prefix: `key-value-stores/${kvId}/`,
      })
    );
    expect(before.Contents?.length ?? 0).toBe(3);

    const { deleteKVStoreS3Prefix } = await import('../../src/storage/s3.js');
    await deleteKVStoreS3Prefix(kvId);

    const after = await s3.send(
      new ListObjectsV2Command({
        Bucket: TEST_CONFIG.s3Bucket,
        Prefix: `key-value-stores/${kvId}/`,
      })
    );
    expect(after.Contents ?? []).toHaveLength(0);
  });
});

describe('reaper — advisory lock', () => {
  it('first runReaperTick acquires the lock; concurrent second tick on a separate connection skips', async () => {
    // Acquire the lock manually on a separate client to simulate "another
    // instance is already reaping". The reaper-under-test should see the
    // lock as held and return cleanly.
    const blockingClient = await pool.connect();
    try {
      const lockResult = await blockingClient.query<{ pg_try_advisory_lock: boolean }>(
        'SELECT pg_try_advisory_lock($1)',
        [0xc0debeef]
      );
      expect(lockResult.rows[0]?.pg_try_advisory_lock).toBe(true);

      // Now invoke the reaper. It should detect the lock and skip.
      const { runReaperTick } = await import('../../src/retention.js');
      // Should not throw, should return cleanly.
      await runReaperTick();
    } finally {
      await blockingClient.query('SELECT pg_advisory_unlock($1)', [0xc0debeef]);
      blockingClient.release();
    }
  });
});

describe('reaper — reapRuns', () => {
  beforeEach(async () => {
    // Clean slate for each test.
    await pool.query(`DELETE FROM retention_tombstones WHERE resource_kind = 'run'`);
    await pool.query(`DELETE FROM runs WHERE id LIKE 'reap-test-%'`);
  });

  it('reaps finished runs older than retentionDays and writes tombstones with metadata', async () => {
    // Insert: one old finished run (eligible), one new finished run (recent),
    // one old unfinished run (no finished_at, ineligible). All reference the
    // shared fixture actor inserted in beforeAll.
    await pool.query(
      `INSERT INTO runs (id, actor_id, user_id, status, finished_at, created_at)
       VALUES
         ('reap-test-old',   'ret-test-actor', 'ret-test-user', 'SUCCEEDED', NOW() - INTERVAL '60 days', NOW() - INTERVAL '61 days'),
         ('reap-test-new',   'ret-test-actor', 'ret-test-user', 'SUCCEEDED', NOW() - INTERVAL '1 day',   NOW() - INTERVAL '2 days'),
         ('reap-test-zomb',  'ret-test-actor', 'ret-test-user', 'RUNNING',   NULL,                       NOW() - INTERVAL '60 days')`
    );

    const { reapRuns } = await import('../../src/retention.js');
    const client = await pool.connect();
    try {
      const reaped = await reapRuns(client);
      expect(reaped).toBe(1);
    } finally {
      client.release();
    }

    // Old finished run: gone.
    const oldExists = await pool.query(`SELECT 1 FROM runs WHERE id = 'reap-test-old'`);
    expect(oldExists.rows).toHaveLength(0);

    // New finished + old unfinished: still there.
    const newExists = await pool.query(`SELECT 1 FROM runs WHERE id = 'reap-test-new'`);
    expect(newExists.rows).toHaveLength(1);
    const zombExists = await pool.query(`SELECT 1 FROM runs WHERE id = 'reap-test-zomb'`);
    expect(zombExists.rows).toHaveLength(1);

    // Tombstone exists with metadata.
    const tomb = await pool.query<{
      resource_id: string;
      reason: string;
      metadata: { actor_id: string; status: string };
    }>(
      `SELECT resource_id, reason, metadata FROM retention_tombstones
        WHERE resource_kind = 'run' AND resource_id = 'reap-test-old'`
    );
    expect(tomb.rows).toHaveLength(1);
    expect(tomb.rows[0]?.reason).toBe('expired-run');
    expect(tomb.rows[0]?.metadata).toEqual({ actor_id: 'ret-test-actor', status: 'SUCCEEDED' });
  });

  it('respects RETENTION_BATCH_SIZE per call', async () => {
    // Insert 5 reapable runs; with batch size 3 only 3 should reap per call.
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO runs (id, actor_id, user_id, status, finished_at, created_at)
         VALUES ($1, 'ret-test-actor', 'ret-test-user', 'SUCCEEDED', NOW() - INTERVAL '60 days', NOW() - INTERVAL '61 days')`,
        [`reap-test-batch-${i}`]
      );
    }

    process.env.RETENTION_BATCH_SIZE = '3';
    vi.resetModules();
    const { reapRuns } = await import('../../src/retention.js');
    const client = await pool.connect();
    try {
      const reaped1 = await reapRuns(client);
      expect(reaped1).toBe(3);
      const reaped2 = await reapRuns(client);
      expect(reaped2).toBe(2);
    } finally {
      client.release();
      delete process.env.RETENTION_BATCH_SIZE;
    }
  });
});

describe('reaper — reapDatasets', () => {
  let s3: S3Client;
  beforeAll(async () => {
    // Re-init S3 in case vi.resetModules() was called by a previous test
    // (e.g. the RETENTION_BATCH_SIZE test), which would clear the module-level
    // s3 client inside storage/s3.js and cause deleteDatasetS3Prefix to fail.
    const { initS3 } = await import('../../src/storage/s3.js');
    await initS3();
    s3 = new S3Client({
      endpoint: TEST_CONFIG.s3Endpoint,
      region: TEST_CONFIG.s3Region,
      credentials: {
        accessKeyId: TEST_CONFIG.s3AccessKey,
        secretAccessKey: TEST_CONFIG.s3SecretKey,
      },
      forcePathStyle: true,
    });
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM retention_tombstones WHERE resource_kind = 'dataset'`);
    await pool.query(`DELETE FROM datasets WHERE id LIKE 'reap-ds-%'`);
  });

  it('reaps unnamed datasets older than retentionDays, with S3 cleanup, and skips named/recent ones', async () => {
    // Old unnamed (eligible).
    await pool.query(
      `INSERT INTO datasets (id, name, user_id, accessed_at, created_at)
       VALUES ('reap-ds-old',  NULL,    'u1', NOW() - INTERVAL '60 days', NOW() - INTERVAL '61 days')`
    );
    // Old named (skipped — named is sacred).
    await pool.query(
      `INSERT INTO datasets (id, name, user_id, accessed_at, created_at)
       VALUES ('reap-ds-named', 'my-ds', 'u1', NOW() - INTERVAL '60 days', NOW() - INTERVAL '61 days')`
    );
    // New unnamed (skipped — within TTL).
    await pool.query(
      `INSERT INTO datasets (id, name, user_id, accessed_at, created_at)
       VALUES ('reap-ds-new',  NULL,    'u1', NOW() - INTERVAL '1 day',   NOW() - INTERVAL '2 days')`
    );

    // Seed an S3 object under the eligible dataset's prefix.
    await s3.send(
      new PutObjectCommand({
        Bucket: TEST_CONFIG.s3Bucket,
        Key: `datasets/reap-ds-old/000000000.batch.json`,
        Body: '[{"x":1}]',
      })
    );

    const { reapDatasets } = await import('../../src/retention.js');
    const client = await pool.connect();
    try {
      const reaped = await reapDatasets(client);
      expect(reaped).toBe(1);
    } finally {
      client.release();
    }

    // Eligible row gone, others remain.
    expect((await pool.query(`SELECT 1 FROM datasets WHERE id = 'reap-ds-old'`)).rows).toHaveLength(
      0
    );
    expect(
      (await pool.query(`SELECT 1 FROM datasets WHERE id = 'reap-ds-named'`)).rows
    ).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM datasets WHERE id = 'reap-ds-new'`)).rows).toHaveLength(
      1
    );

    // Tombstone written.
    const tomb = await pool.query(
      `SELECT reason FROM retention_tombstones
        WHERE resource_kind = 'dataset' AND resource_id = 'reap-ds-old'`
    );
    expect(tomb.rows[0]?.reason).toBe('expired-unnamed');

    // S3 prefix cleaned.
    const after = await s3.send(
      new ListObjectsV2Command({
        Bucket: TEST_CONFIG.s3Bucket,
        Prefix: `datasets/reap-ds-old/`,
      })
    );
    expect(after.Contents ?? []).toHaveLength(0);

    // Cleanup the named row we left behind.
    await pool.query(`DELETE FROM datasets WHERE id IN ('reap-ds-named', 'reap-ds-new')`);
  });
});
