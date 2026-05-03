/**
 * Retention reaper integration tests — exercise real PG + MinIO via the
 * shared integration setup. Slice #3.
 *
 * The shared beforeAll initialises the API's module-level pool/redis/s3
 * (NOT a separate local pool) so that code under test like runReaperTick(),
 * which imports `pool` from db/index.js, sees the same connection pool
 * the tests use for direct setup queries.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
});
