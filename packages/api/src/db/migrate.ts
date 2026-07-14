/**
 * Database schema for Crawlee Platform.
 *
 * Uses short, human-friendly IDs (Apify-style) instead of UUIDs.
 * Run this migration with: npm run db:migrate
 */

import { pool } from './index.js';

const schema = `
-- Datasets
CREATE TABLE IF NOT EXISTS datasets (
  id VARCHAR(21) PRIMARY KEY,
  name TEXT UNIQUE,
  user_id VARCHAR(21),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  modified_at TIMESTAMPTZ DEFAULT NOW(),
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  item_count INTEGER DEFAULT 0
);

-- Key-Value Stores
CREATE TABLE IF NOT EXISTS key_value_stores (
  id VARCHAR(21) PRIMARY KEY,
  name TEXT UNIQUE,
  user_id VARCHAR(21),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  modified_at TIMESTAMPTZ DEFAULT NOW(),
  accessed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Request Queues (metadata only, requests in separate table)
CREATE TABLE IF NOT EXISTS request_queues (
  id VARCHAR(21) PRIMARY KEY,
  name TEXT UNIQUE,
  user_id VARCHAR(21),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  modified_at TIMESTAMPTZ DEFAULT NOW(),
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  total_request_count INTEGER DEFAULT 0,
  handled_request_count INTEGER DEFAULT 0,
  pending_request_count INTEGER DEFAULT 0,
  had_multiple_clients BOOLEAN DEFAULT FALSE
);

-- Individual requests in request queues
CREATE TABLE IF NOT EXISTS requests (
  id VARCHAR(21) PRIMARY KEY,
  queue_id VARCHAR(21) NOT NULL REFERENCES request_queues(id) ON DELETE CASCADE,
  unique_key TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT DEFAULT 'GET',
  payload TEXT,
  retry_count INTEGER DEFAULT 0,
  no_retry BOOLEAN DEFAULT FALSE,
  error_messages TEXT[],
  headers JSONB,
  user_data JSONB,
  handled_at TIMESTAMPTZ,
  order_no BIGSERIAL,
  
  -- Request locking for distributed crawling
  locked_until TIMESTAMPTZ,
  locked_by TEXT,
  
  -- Deduplication constraint
  UNIQUE(queue_id, unique_key)
);

-- Index for fast head queries (pending, not locked, ordered)
CREATE INDEX IF NOT EXISTS idx_requests_pending ON requests (queue_id, order_no)
  WHERE handled_at IS NULL;

-- Covers the two COUNT aggregates inside POST /head/lock that filter by
-- (queue_id, locked_until). Without this, those scan the queue's slice of
-- requests for every poll cycle — fine on day 1, painful as the table grows
-- under sustained crawls. Partial on handled_at IS NULL because handled rows
-- are never re-locked.
CREATE INDEX IF NOT EXISTS idx_requests_locked
  ON requests (queue_id, locked_until)
  WHERE handled_at IS NULL;

-- Actors
CREATE TABLE IF NOT EXISTS actors (
  id VARCHAR(21) PRIMARY KEY,
  name TEXT NOT NULL,
  user_id VARCHAR(21),
  title TEXT,
  description TEXT,
  default_run_options JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  modified_at TIMESTAMPTZ DEFAULT NOW(),
  current_version_id VARCHAR(21),
  
  UNIQUE(user_id, name)
);

-- Actor runs
CREATE TABLE IF NOT EXISTS runs (
  id VARCHAR(21) PRIMARY KEY,
  actor_id VARCHAR(21) REFERENCES actors(id),
  user_id VARCHAR(21),
  status TEXT DEFAULT 'READY',
  status_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  
  -- Default storage IDs for this run
  default_dataset_id VARCHAR(21) REFERENCES datasets(id),
  default_key_value_store_id VARCHAR(21) REFERENCES key_value_stores(id),
  default_request_queue_id VARCHAR(21) REFERENCES request_queues(id),
  
  -- Run options
  timeout_secs INTEGER DEFAULT 3600,
  memory_mbytes INTEGER DEFAULT 1024,
  
  -- Container info
  container_url TEXT,
  
  -- Build info (Apify compatibility)
  build_id VARCHAR(21),
  build_number TEXT,
  exit_code INTEGER,
  
  -- Run stats (computed values)
  stats_json JSONB,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  modified_at TIMESTAMPTZ DEFAULT NOW()
);

-- Runs list/triage indexes. Without these, the dashboard's runs page does
-- a seq scan over the entire table on every load — at 280 runs/day that's
-- thousands of rows per month per user. Composite indexes are ordered to
-- match the GET /v2/actor-runs query: WHERE user_id = ? AND ... ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_runs_user_created
  ON runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_user_status_created
  ON runs(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_user_actor_created
  ON runs(user_id, actor_id, created_at DESC);

-- Webhooks
CREATE TABLE IF NOT EXISTS webhooks (
  id VARCHAR(21) PRIMARY KEY,
  user_id VARCHAR(21),
  event_types TEXT[] NOT NULL,
  request_url TEXT NOT NULL,
  payload_template TEXT,
  is_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(21) PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  modified_at TIMESTAMPTZ DEFAULT NOW()
);

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
  id VARCHAR(21) PRIMARY KEY,
  user_id VARCHAR(21) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_preview TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- Actor Versions (Docker images)
CREATE TABLE IF NOT EXISTS actor_versions (
  id VARCHAR(21) PRIMARY KEY,
  actor_id VARCHAR(21) NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  version_number TEXT NOT NULL,
  source_type TEXT DEFAULT 'GIT_REPO', -- GIT_REPO, TARBALL, GITHUB_GIST
  source_url TEXT,
  dockerfile TEXT,
  build_tag TEXT,
  env_vars JSONB,
  is_deprecated BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Each actor can only have one of each version number
  UNIQUE(actor_id, version_number)
);

-- A given build_tag (e.g. "latest", "beta") may only point at ONE version
-- per actor at a time. A partial index excludes NULL tags (untagged
-- versions are normal) but enforces uniqueness for any actively-set tag.
-- This is the DB-level invariant that makes "current pointer" semantics
-- ironclad against:
--   (a) concurrent push races where two writers' clear-then-set CTEs
--       interleave and both end up holding the tag,
--   (b) any code path that bypasses findOrCreateActorVersion and writes
--       build_tag directly (e.g. the POST /v2/acts/:id/versions route).
CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_versions_actor_tag
  ON actor_versions(actor_id, build_tag) WHERE build_tag IS NOT NULL;

-- Actor Builds (build history)
CREATE TABLE IF NOT EXISTS actor_builds (
  id VARCHAR(21) PRIMARY KEY,
  actor_id VARCHAR(21) NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  version_id VARCHAR(21) REFERENCES actor_versions(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'READY', -- READY, RUNNING, SUCCEEDED, FAILED
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  
  -- Docker image info
  image_name TEXT,
  image_digest TEXT,
  image_size_bytes BIGINT,
  
  -- Build logs stored in Redis (logs:<buildId>)
  log_count INTEGER DEFAULT 0,
  
  -- Git info
  git_branch TEXT,
  git_commit TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actor_versions_actor ON actor_versions(actor_id);
CREATE INDEX IF NOT EXISTS idx_actor_builds_actor ON actor_builds(actor_id);

-- Add foreign key for current_version_id in actors
ALTER TABLE actors DROP CONSTRAINT IF EXISTS actors_current_version_id_fkey;
ALTER TABLE actors ADD CONSTRAINT actors_current_version_id_fkey
  FOREIGN KEY (current_version_id) REFERENCES actor_versions(id);

-- Schedules (cron jobs)
CREATE TABLE IF NOT EXISTS schedules (
  id VARCHAR(21) PRIMARY KEY,
  user_id VARCHAR(21) REFERENCES users(id) ON DELETE CASCADE,
  actor_id VARCHAR(21) NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  is_enabled BOOLEAN DEFAULT TRUE,
  input JSONB,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  modified_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(is_enabled) WHERE is_enabled = true;

-- Webhook deliveries (tracking + retry)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id VARCHAR(21) PRIMARY KEY,
  webhook_id VARCHAR(21) NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  run_id VARCHAR(21),
  event_type TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING',
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  response_status INTEGER,
  response_body TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
  ON webhook_deliveries(next_retry_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook
  ON webhook_deliveries(webhook_id);

-- Captures the rendered JSON body actually sent to the receiver. Distinct
-- from webhooks.payload_template (the configured form with {{placeholders}})
-- because operators triaging "the receiver rejected this" need to see the
-- exact bytes, not the pre-render shape. NULL for legacy deliveries written
-- before this column existed.
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS request_body TEXT;

-- Add columns to webhooks table
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS actor_id VARCHAR(21) REFERENCES actors(id) ON DELETE SET NULL;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS headers JSONB;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS modified_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS run_id VARCHAR(21) REFERENCES runs(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_webhooks_run_id ON webhooks(run_id) WHERE run_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_webhooks_scope') THEN
    ALTER TABLE webhooks ADD CONSTRAINT chk_webhooks_scope
      CHECK (NOT (actor_id IS NOT NULL AND run_id IS NOT NULL));
  END IF;
END $$;

-- Add retry columns to actors table
ALTER TABLE actors ADD COLUMN IF NOT EXISTS max_retries INTEGER DEFAULT 0;
ALTER TABLE actors ADD COLUMN IF NOT EXISTS retry_delay_secs INTEGER DEFAULT 60;

-- Add retry/scheduling columns to runs table
ALTER TABLE runs ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS origin_run_id VARCHAR(21);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS run_after TIMESTAMPTZ;

-- Retention slice #3: tombstone audit log for reaped resources.
-- BIGSERIAL diverges from the project-wide VARCHAR(21) nanoid convention
-- because tombstones are operator-internal — never user-referenced, never
-- URL-shared, benefit from monotonic insertion order for time-window queries.
-- user_id has no FK by design: tombstones must outlive users (audit trail).
CREATE TABLE IF NOT EXISTS retention_tombstones (
  id BIGSERIAL PRIMARY KEY,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN
    ('dataset', 'key_value_store', 'request_queue', 'run')),
  resource_id VARCHAR(21) NOT NULL,
  resource_name TEXT,
  user_id VARCHAR(21),
  reason TEXT NOT NULL CHECK (reason IN ('expired-unnamed', 'expired-run')),
  original_created_at TIMESTAMPTZ,
  metadata JSONB,
  deleted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tombstones_deleted_at
  ON retention_tombstones(deleted_at DESC);

-- Retention slice #3: storage referenced by a run becomes NULL when storage
-- is reaped, instead of failing the DELETE. Lets the reaper run runs and
-- storage in either order without coordination.
--
-- Three explicit DROP+ADD migrations because PG auto-named constraints don't
-- support ALTER MODIFY in place. Constraint names follow PG's default
-- pattern: {table}_{column}_fkey.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_default_dataset_id_fkey;
ALTER TABLE runs ADD CONSTRAINT runs_default_dataset_id_fkey
  FOREIGN KEY (default_dataset_id) REFERENCES datasets(id) ON DELETE SET NULL;

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_default_key_value_store_id_fkey;
ALTER TABLE runs ADD CONSTRAINT runs_default_key_value_store_id_fkey
  FOREIGN KEY (default_key_value_store_id) REFERENCES key_value_stores(id) ON DELETE SET NULL;

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_default_request_queue_id_fkey;
ALTER TABLE runs ADD CONSTRAINT runs_default_request_queue_id_fkey
  FOREIGN KEY (default_request_queue_id) REFERENCES request_queues(id) ON DELETE SET NULL;

-- Retention slice #3: partial indexes matching the reaper's eligibility
-- predicate, so the sweep query is O(eligible) regardless of total table
-- size. Each storage index covers (accessed_at) over rows where name IS NULL;
-- runs covers (finished_at) over rows where finished_at IS NOT NULL.
CREATE INDEX IF NOT EXISTS idx_datasets_unnamed_accessed
  ON datasets(accessed_at) WHERE name IS NULL;
CREATE INDEX IF NOT EXISTS idx_kv_stores_unnamed_accessed
  ON key_value_stores(accessed_at) WHERE name IS NULL;
CREATE INDEX IF NOT EXISTS idx_request_queues_unnamed_accessed
  ON request_queues(accessed_at) WHERE name IS NULL;
CREATE INDEX IF NOT EXISTS idx_runs_finished
  ON runs(finished_at) WHERE finished_at IS NOT NULL;

-- The scaler polls active rows every 30s (status IN ('READY','RUNNING')
-- GROUP BY, plus a RUNNING-row fetch feeding zombie detection), and the
-- runner's claim query filters on status='READY'. Partial over just the
-- active statuses: stays tiny (bounded by maxRunners * runsPerRunner + queue
-- depth) no matter how many terminal rows accumulate, unlike a full
-- runs(status) index which would be ~all SUCCEEDED/FAILED rows.
CREATE INDEX IF NOT EXISTS idx_runs_status_active
  ON runs(status) WHERE status IN ('READY', 'RUNNING');

ALTER TABLE users  ADD COLUMN IF NOT EXISTS proxy_password_encrypted TEXT;
ALTER TABLE actors ADD COLUMN IF NOT EXISTS proxy_password_encrypted TEXT;
`;

export async function migrate(): Promise<void> {
  console.log('Running database migrations...');
  await pool.query(schema);
  console.log('Migrations completed successfully');
}

// Run migration if called directly
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  import('./index.js')
    .then(({ initDatabase }) => initDatabase().then(() => migrate().then(() => process.exit(0))))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
