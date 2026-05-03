# Hobby Deployment — Docker Compose on a Single VPS

This recipe is for self-hosted single-machine deployments. All components
(PostgreSQL, Redis, MinIO, API server, runner) run on the same host via
docker-compose. Suitable for small workloads — a few actors per day,
hundreds-to-thousands of dataset items per run, ≤ 10 concurrent runs.

## Prerequisites

- A VPS with at least 2 vCPUs and 4 GB RAM. Disk: at least 20 GB SSD.
- Docker Engine ≥ 24.0 and Docker Compose v2.

## Setup

1. Clone the repo and copy the env template:

   ```bash
   git clone https://github.com/crawlee-cloud/crawlee-cloud.git
   cd crawlee-cloud
   cp .env.example .env
   ```

2. Edit `.env`. Minimum required: set `API_SECRET` to at least 32 random
   characters, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the initial admin
   user. Defaults for everything else are fine for hobby scale.

3. Start the infrastructure:

   ```bash
   npm install
   npm run docker:dev    # starts PG, Redis, MinIO
   npm run db:migrate --workspace=@crawlee-cloud/api
   npm run dev           # starts API + runner
   ```

## Tunables relevant for this tier

All defaults work. The defaults specifically tested for this tier:

- `DB_POOL_MAX=8` — fits the in-container PG default of `max_connections=100`
  with plenty of headroom.
- `DATASET_BATCH_SIZE=500` — bounds memory during downloads of large
  datasets and keeps S3 PUT count manageable on local MinIO.
- `RETENTION_ENABLED=true` — daily reaper at 03:00 UTC. On a small dataset
  count, the tick finishes in milliseconds.
- `RETENTION_DAYS=30` — Apify default. Unnamed datasets/KVs/queues +
  finished runs older than 30 days get cleaned up.

## Operating notes

- **First tick after a long-running deployment**: if you've been running
  pre-slice-3 for months, the first reaper tick will start draining the
  backlog at `RETENTION_BATCH_SIZE` per phase per tick. Default settings
  drain ~2000 entities/day. To accelerate, temporarily set
  `RETENTION_CRON='*/15 * * * *'` (every 15 minutes) and/or raise
  `RETENTION_BATCH_SIZE=5000`. Revert once the backlog is gone.

- **Audit log**: query `retention_tombstones` directly to see what got
  reaped:

  ```sql
  SELECT resource_kind, resource_name, reason, original_created_at, deleted_at
    FROM retention_tombstones
   WHERE deleted_at > NOW() - INTERVAL '7 days'
   ORDER BY deleted_at DESC;
  ```

- **Disabling retention**: set `RETENTION_ENABLED=false` in `.env`,
  restart the API. The reaper does not register and tables grow forever.
  Use this if you need to preserve all data for compliance or are
  intentionally archiving.
