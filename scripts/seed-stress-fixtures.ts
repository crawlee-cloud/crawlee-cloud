/**
 * Stress-test fixtures: bulk-insert datasets, KV stores, request queues,
 * runs, schedules and webhooks so the dashboard pagination, retention
 * reaper, and list-endpoint COUNT(*) paths exercise realistic volumes.
 *
 * Idempotent: every row uses an ID prefixed with `stress-` so a
 * subsequent --teardown wipes only fixture rows. Re-running --seed is a
 * no-op past the first invocation thanks to ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   npx tsx scripts/seed-stress-fixtures.ts --seed --count 5000
 *   npx tsx scripts/seed-stress-fixtures.ts --teardown
 *
 * Flags:
 *   --seed                Insert fixtures (default if no flag).
 *   --teardown            Delete every row with id LIKE 'stress-%'.
 *   --count N             Per-table row count (default 5000).
 *   --schedule-count N    Schedules count (default 100).
 *   --webhook-count N     Webhooks count (default 100).
 *   --actor-count N       Actors count (default 200).
 *
 * Reads DATABASE_URL from env (.env loaded automatically by tsx if set).
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}
const teardown = args.includes('--teardown');
const count = parseInt(getArg('count', '5000'), 10);
const scheduleCount = parseInt(getArg('schedule-count', '100'), 10);
const webhookCount = parseInt(getArg('webhook-count', '100'), 10);
const actorCount = parseInt(getArg('actor-count', '200'), 10);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getSeedRefs(): Promise<{ userId: string; actorId: string }> {
  // Prefer the operator from .env (ADMIN_EMAIL); fall back to oldest admin.
  // This matters when more than one admin exists — fixtures are scoped to a
  // single user via FK, so picking the wrong owner makes them invisible to
  // the dashboard session.
  const email = getArg('user-email', process.env.ADMIN_EMAIL ?? '');
  const u = email
    ? await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [email])
    : await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`
      );
  if (u.rows.length === 0) {
    throw new Error(
      email ? `No user with email=${email} found.` : 'No admin user found. Bootstrap one first.'
    );
  }
  const userId = u.rows[0]!.id;
  // Look for an actor owned by this same user; fall back to any actor.
  const a = await pool.query<{ id: string }>(
    `SELECT id FROM actors WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [userId]
  );
  if (a.rows.length === 0) {
    const fallback = await pool.query<{ id: string }>(
      `SELECT id FROM actors ORDER BY created_at ASC LIMIT 1`
    );
    if (fallback.rows.length === 0) {
      throw new Error('No actors found. Create at least one actor first.');
    }
    return { userId, actorId: fallback.rows[0]!.id };
  }
  return { userId, actorId: a.rows[0]!.id };
}

async function seed(): Promise<void> {
  const { userId, actorId } = await getSeedRefs();
  console.log(`[seed] using user_id=${userId} actor_id=${actorId}`);

  const t0 = Date.now();

  // Actors: must be inserted before runs/schedules (which FK to actors.id).
  // The (user_id, name) UNIQUE constraint is satisfied by zero-padding the
  // name suffix per index.
  await pool.query(
    `INSERT INTO actors (id, name, user_id, title, description, created_at, modified_at)
     SELECT
       'stress-ac-' || lpad(g::text, 11, '0'),
       'stress-actor-' || lpad(g::text, 6, '0'),
       $1,
       'Stress fixture actor #' || g,
       'Synthetic actor inserted by seed-stress-fixtures.ts',
       NOW() - (random() * 120 || ' days')::interval,
       NOW() - (random() * 120 || ' days')::interval
     FROM generate_series(1, $2) AS g
     ON CONFLICT (id) DO NOTHING`,
    [userId, actorCount]
  );
  console.log(`[seed] actors: ${actorCount} rows (cumulative ${Date.now() - t0}ms)`);

  // Datasets: mix of ages so the retention reaper has something to chew on.
  // accessed_at spans NOW() - 0..120 days uniformly.
  await pool.query(
    `INSERT INTO datasets (id, name, user_id, created_at, modified_at, accessed_at, item_count)
     SELECT
       'stress-ds-' || lpad(g::text, 11, '0'),
       NULL,
       $1,
       NOW() - (random() * 120 || ' days')::interval,
       NOW() - (random() * 120 || ' days')::interval,
       NOW() - (random() * 120 || ' days')::interval,
       (random() * 10000)::int
     FROM generate_series(1, $2) AS g
     ON CONFLICT (id) DO NOTHING`,
    [userId, count]
  );
  console.log(`[seed] datasets: ${count} rows (cumulative ${Date.now() - t0}ms)`);

  await pool.query(
    `INSERT INTO key_value_stores (id, name, user_id, created_at, modified_at, accessed_at)
     SELECT
       'stress-kv-' || lpad(g::text, 11, '0'),
       NULL,
       $1,
       NOW() - (random() * 120 || ' days')::interval,
       NOW() - (random() * 120 || ' days')::interval,
       NOW() - (random() * 120 || ' days')::interval
     FROM generate_series(1, $2) AS g
     ON CONFLICT (id) DO NOTHING`,
    [userId, count]
  );
  console.log(`[seed] key_value_stores: ${count} rows (cumulative ${Date.now() - t0}ms)`);

  await pool.query(
    `INSERT INTO request_queues
       (id, name, user_id, created_at, modified_at, accessed_at,
        total_request_count, handled_request_count, pending_request_count)
     SELECT
       'stress-rq-' || lpad(g::text, 11, '0'),
       NULL,
       $1,
       NOW() - (random() * 120 || ' days')::interval,
       NOW() - (random() * 120 || ' days')::interval,
       NOW() - (random() * 120 || ' days')::interval,
       (random() * 5000)::int,
       (random() * 4000)::int,
       (random() * 1000)::int
     FROM generate_series(1, $2) AS g
     ON CONFLICT (id) DO NOTHING`,
    [userId, count]
  );
  console.log(`[seed] request_queues: ${count} rows (cumulative ${Date.now() - t0}ms)`);

  // Runs: status mix biased towards SUCCEEDED. finished_at set for
  // terminal statuses so retention.reapRuns has eligible rows.
  await pool.query(
    `INSERT INTO runs
       (id, actor_id, user_id, status, started_at, finished_at,
        timeout_secs, memory_mbytes)
     SELECT
       'stress-rn-' || lpad(g::text, 11, '0'),
       $1,
       $2,
       (ARRAY['SUCCEEDED','SUCCEEDED','SUCCEEDED','FAILED','TIMED-OUT'])[1 + (random() * 4)::int],
       NOW() - (random() * 120 || ' days')::interval,
       NOW() - (random() * 120 || ' days')::interval,
       3600,
       1024
     FROM generate_series(1, $3) AS g
     ON CONFLICT (id) DO NOTHING`,
    [actorId, userId, count]
  );
  console.log(`[seed] runs: ${count} rows (cumulative ${Date.now() - t0}ms)`);

  await pool.query(
    `INSERT INTO schedules
       (id, user_id, actor_id, name, cron_expression, timezone, is_enabled, created_at, modified_at)
     SELECT
       'stress-sc-' || lpad(g::text, 11, '0'),
       $1,
       $2,
       'stress-schedule-' || g,
       '0 * * * *',
       'UTC',
       (g % 2 = 0),
       NOW(),
       NOW()
     FROM generate_series(1, $3) AS g
     ON CONFLICT (id) DO NOTHING`,
    [userId, actorId, scheduleCount]
  );
  console.log(`[seed] schedules: ${scheduleCount} rows (cumulative ${Date.now() - t0}ms)`);

  await pool.query(
    `INSERT INTO webhooks
       (id, user_id, event_types, request_url, payload_template, is_enabled, created_at)
     SELECT
       'stress-wh-' || lpad(g::text, 11, '0'),
       $1,
       ARRAY['ACTOR.RUN.SUCCEEDED','ACTOR.RUN.FAILED'],
       'https://example.com/webhook/' || g,
       NULL,
       (g % 2 = 0),
       NOW()
     FROM generate_series(1, $2) AS g
     ON CONFLICT (id) DO NOTHING`,
    [userId, webhookCount]
  );
  console.log(`[seed] webhooks: ${webhookCount} rows (cumulative ${Date.now() - t0}ms)`);

  console.log(`[seed] done in ${Date.now() - t0}ms`);
}

async function teardownAll(): Promise<void> {
  const t0 = Date.now();
  // Order matters: rows that FK to actors must be deleted before actors
  // (FKs default to ON DELETE RESTRICT for runs.actor_id).
  const tables = [
    'webhooks',
    'schedules',
    'runs',
    'request_queues',
    'key_value_stores',
    'datasets',
    'actors',
    'retention_tombstones',
  ];
  for (const table of tables) {
    const col = table === 'retention_tombstones' ? 'resource_id' : 'id';
    const r = await pool.query(`DELETE FROM ${table} WHERE ${col} LIKE 'stress-%'`);
    console.log(`[teardown] ${table}: ${r.rowCount} rows`);
  }
  console.log(`[teardown] done in ${Date.now() - t0}ms`);
}

async function main(): Promise<void> {
  try {
    if (teardown) {
      await teardownAll();
    } else {
      await seed();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
