# Production Deployment — DigitalOcean Managed PG + Managed Redis + Spaces

This recipe is for production deployments using DigitalOcean's managed
services. The API runs on DigitalOcean App Platform or a DO Droplet
(potentially in a multi-instance setup behind a load balancer); PostgreSQL
is DO Managed Postgres; Redis is DO Managed Redis; object storage is DO
Spaces (S3-compatible).

## Prerequisites

- A DO project with: Managed Postgres (1 GB minimum, 4 GB+ recommended for
  production loads), Managed Redis (1 GB minimum), a Spaces bucket.
- Connection URIs for all three services available.

## Setup

1. Provision the three managed services. Note the connection URIs.

2. Deploy the API and runner. Set the following env vars from your
   provisioning output:

   ```
   DATABASE_URL=postgres://...                # from DO Managed PG
   REDIS_URL=rediss://...                     # from DO Managed Redis (TLS by default)
   S3_ENDPOINT=https://<region>.digitaloceanspaces.com
   S3_ACCESS_KEY=<spaces-key>
   S3_SECRET_KEY=<spaces-secret>
   S3_BUCKET=<your-bucket>
   S3_FORCE_PATH_STYLE=false                  # Spaces uses virtual-host style
   API_SECRET=<>=32-random-chars>
   ADMIN_EMAIL=<initial-admin-email>
   ADMIN_PASSWORD=<initial-admin-password>
   ```

3. Run the migration once (from any one instance):

   ```bash
   npm run db:migrate --workspace=@crawlee-cloud/api
   ```

## Tunables for this tier

### `DB_POOL_MAX` — sized to your PG plan

DO Managed Postgres has hard connection ceilings tied to plan size. The
slice-#1 default of 8 fits the smallest (1 GB) plan; bump on larger plans:

| PG plan size | Connection ceiling | Recommended `DB_POOL_MAX` |
| ------------ | ------------------ | ------------------------- |
| 1 GB         | 22                 | 8 (default)               |
| 2 GB         | 25                 | 12                        |
| 4 GB         | 50                 | 30                        |
| 8 GB+        | 97+                | 50                        |

Headroom matters: the reaper holds one connection per tick (slice #3),
manual `psql` sessions need room, and migrations need at least one
connection. Don't size pool to ceiling.

If you enable DO Managed Postgres's connection-pooler endpoint
(PgBouncer in transaction mode), the application-side `max` becomes
near-irrelevant — set high (50+) and let the pooler multiplex.

### `DATASET_BATCH_SIZE` — Spaces PUT cost vs. batch memory

Default of 500 keeps PUT cost low (~115 PUTs/sec on 10M-items/day workload
with batched datasets) without ballooning per-batch memory.

- For high-volume actors that cost-optimize aggressively: raise to 1000–2000.
- If you see memory pressure during dataset downloads: lower to 100–200.

### `RETENTION_*` — slice #3 retention policy

All defaults work for production:

- `RETENTION_ENABLED=true` — reaper registers daily at 03:00 UTC.
- `RETENTION_DAYS=30` — Apify-style 30-day TTL for unnamed storage +
  finished runs.
- `RETENTION_TOMBSTONE_DAYS=365` — year-long audit window.
- `RETENTION_BATCH_SIZE=500` — bounds per-tick work; safe for typical
  scrapers.

**Multi-instance API deployments need no extra coordination.** The
in-process reaper uses a Postgres advisory lock for leader election:
whichever instance's cron fires first acquires the lock, the others see
the lock held and skip.

### Operational caveats

- **Phase 4 long CASCADE**: if you produce request queues with very large
  request counts (≥100K rows), the queue-reap CASCADE on the `requests`
  table can hold table-level locks for tens of seconds. Lower
  `RETENTION_BATCH_SIZE` globally during the drain window if you observe
  query latency spikes.

- **First tick after deploy on a long-lived DB**: if you're enabling
  retention for the first time on a deployment that's been running for
  months, expect the first ticks to be draining accumulated backlog. With
  defaults that's ~2000 entities/day. To drain faster temporarily:
  `RETENTION_CRON='*/15 * * * *'` + `RETENTION_BATCH_SIZE=5000`. Revert
  once steady state is reached.

- **Spaces lifecycle policies**: Spaces supports S3 lifecycle rules. The
  retention reaper does application-driven deletion (issues
  DeleteObjects after each PG transaction commits), so you do _not_ need
  to configure Spaces lifecycle. If you do configure both, lifecycle
  rules act as a safety net for any leaked-bytes corner case where the
  reaper's S3 cleanup failed.

- **Pre-slice-1 raw-SQL deletes**: if your deployment has any pre-existing
  orphan FK pointers (a run referencing a dataset row that was manually
  deleted via raw SQL), the slice-#3 migration's
  `ALTER TABLE ADD CONSTRAINT` step will fail. Run the diagnostic SQL
  below before deploying, and clean any rows it returns:

  ```sql
  SELECT 'datasets' AS missing, r.id AS run_id, r.default_dataset_id AS orphan_id
    FROM runs r
    LEFT JOIN datasets d ON r.default_dataset_id = d.id
    WHERE r.default_dataset_id IS NOT NULL AND d.id IS NULL
  UNION ALL
  SELECT 'key_value_stores', r.id, r.default_key_value_store_id
    FROM runs r
    LEFT JOIN key_value_stores k ON r.default_key_value_store_id = k.id
    WHERE r.default_key_value_store_id IS NOT NULL AND k.id IS NULL
  UNION ALL
  SELECT 'request_queues', r.id, r.default_request_queue_id
    FROM runs r
    LEFT JOIN request_queues q ON r.default_request_queue_id = q.id
    WHERE r.default_request_queue_id IS NOT NULL AND q.id IS NULL;
  ```

  Resolution: either UPDATE the offending run rows to NULL the orphan FK,
  or DELETE the orphan run rows entirely.

## Audit & observability

- **Tombstone log**: `SELECT * FROM retention_tombstones ORDER BY
deleted_at DESC LIMIT 100;` shows the most-recently-reaped resources.
- **Status endpoint**: `GET /v2/system/retention/status` (admin auth)
  returns last tick timestamp/duration plus 24h reap counts by kind.
