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
`;

export async function migrate(): Promise<void> {
  console.log('Running database migrations...');
  await pool.query(schema);
  console.log('Migrations completed successfully');
}

// Run migration if called directly
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  import('./index.js').then(({ initDatabase }) => 
    initDatabase().then(() => migrate().then(() => process.exit(0)))
  ).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
