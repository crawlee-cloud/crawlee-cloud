# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Commits

Do not add Co-Authored-By trailers to git commits.

## Overview

Crawlee Cloud is a self-hosted, open-source platform for running Apify Actors on your own infrastructure. It provides an Apify-compatible API (v2) that allows existing Actor code to run without modifications by simply changing the `APIFY_API_BASE_URL` environment variable.

## Repository Structure

This is a monorepo managed with npm workspaces and Turborepo:

- `packages/api` - Fastify-based REST API server (Apify v2 compatible)
- `packages/runner` - Docker container orchestrator that polls and executes Actor runs
- `packages/dashboard` - Next.js web UI for monitoring and management
- `packages/cli` - Command-line tool for deploying and running Actors

## Commands

### Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run API server in dev mode (with watch)
npm run dev

# Run specific package in dev mode
npm run dev --workspace=@crawlee-cloud/api
npm run dev --workspace=@crawlee-cloud/runner
npm run dev --workspace=@crawlee-cloud/dashboard
```

### Testing & Quality

```bash
# Run all tests (uses vitest workspace)
npm test

# Run tests for specific package
npm test --workspace=@crawlee-cloud/api

# Type checking across all packages
npm run typecheck

# Linting
npm run lint
npm run lint:fix
```

### Database

```bash
# Run migrations (creates/updates PostgreSQL schema)
npm run db:migrate

# Or run directly in API package
npm run db:migrate --workspace=@crawlee-cloud/api
```

### Security

```bash
# Run npm audit for vulnerabilities
npm run security:audit

# Validate environment config for insecure defaults
npm run security:validate-config
```

### Docker Infrastructure

```bash
# Start dev infrastructure (PostgreSQL, Redis, MinIO)
npm run docker:dev

# Stop all containers
npm run docker:down
```

### CLI Development

```bash
# Run CLI in development
npm run dev --workspace=@crawlee-cloud/cli

# Example CLI commands
cd packages/cli
npm run dev -- login
npm run dev -- push my-actor
npm run dev -- run my-actor
```

## Architecture

### Core Flow

1. **API Server** (`packages/api`) receives Actor run requests via REST endpoints
2. Creates run record in PostgreSQL with `READY` status
3. Publishes notification to Redis (`run:new` channel)
4. **Runner** (`packages/runner`) polls/receives notification
5. Runner pulls run from database, spawns Docker container with Actor environment
6. Actor executes using Apify SDK, storing data via API endpoints
7. Runner updates run status to `SUCCEEDED`, `FAILED`, or `TIMED-OUT`
8. Optional webhooks are triggered on completion

### API Server (packages/api)

Built with Fastify, implements Apify v2 API endpoints:

- **Routes** (`src/routes/`) - Organized by resource type:
  - `actors.ts` - Actor CRUD and metadata
  - `runs.ts` - Run lifecycle management
  - `datasets.ts` - Dataset storage (items stored in S3, metadata in PostgreSQL)
  - `key-value-stores.ts` - Key-value storage (values in S3, metadata in PostgreSQL)
  - `request-queues.ts` - Request queue operations (requests in PostgreSQL with distributed locking)
  - `logs.ts` - Run logs (stored in Redis)
  - `auth.ts` - User authentication (JWT-based)
  - `registry.ts` - Actor version/build management
  - `users.ts` - User management
  - `webhooks.ts` - Webhook CRUD, deliveries, and test dispatch
  - `schedules.ts` - Cron-based scheduled runs
  - `scaler.ts` - Autoscaler status (admin-only)
  - `system.ts` - System info and retention status (admin-only)

- **Validation Schemas** (`src/schemas/`) - Zod schemas for request validation:
  - `actors.ts` - Actor create/update/run schemas
  - `datasets.ts` - Dataset create schema
  - `key-value-stores.ts` - KV store create schema
  - `request-queues.ts` - Queue create, add request, batch add, update request schemas
  - `runs.ts` - Run update schema

- **Configuration** (`src/`):
  - `config.ts` - Typed configuration with dev defaults and production enforcement
  - `config-validator.ts` - Security validation at startup (weak secrets, insecure defaults, CORS)

- **Platform Services** (`src/`):
  - `scheduler.ts` - Cron tick loop that dispatches scheduled runs
  - `retention.ts` - Data retention/cleanup job (tombstones, configurable via `RETENTION_*`)
  - `scaler/` - Runner autoscaler with pluggable cloud providers (`providers/`)
  - `metrics.ts` - Prometheus metrics (`/metrics`, admin-only unless `METRICS_PUBLIC=true`)
  - `health.ts` - Liveness/readiness probes (`/health/live`, `/health/ready`)
  - `lib/run-cost.ts` - Compute-unit cost attribution for runs
  - `webhooks/apply-template.ts` - Apify-compatible webhook payload templating (kept in sync with the runner's copy)

- **Storage Layer** (`src/storage/`):
  - `s3.ts` - S3-compatible object storage (MinIO, AWS S3, etc.)
  - `redis.ts` - Redis for caching, queues, and logs

- **Database** (`src/db/`):
  - `index.ts` - PostgreSQL connection pool
  - `migrate.ts` - Schema migrations (idempotent SQL)

- **Authentication** (`src/auth/`):
  - JWT-based auth with API keys stored in PostgreSQL
  - `middleware.ts` - Auth middleware for protected routes

### Runner (packages/runner)

Docker orchestration service:

- **Queue Processing** (`src/queue.ts`):
  - Polls PostgreSQL for runs with `READY` status using `FOR UPDATE SKIP LOCKED`
  - Subscribes to Redis `run:new` channel for instant notifications
  - Processes runs concurrently (configurable via `MAX_CONCURRENT_RUNS`)
  - Handles webhook triggers on run completion

- **Docker Execution** (`src/docker.ts`):
  - Uses `dockerode` library to spawn containers
  - Injects Apify SDK environment variables (`APIFY_TOKEN`, `APIFY_API_BASE_URL`, etc.)
  - Streams logs to Redis during execution
  - Enforces memory limits and timeouts
  - Merges env vars: base env < actor env (from actor.json) < runtime env (from CLI `-e` flag)

- **Supporting Modules** (`src/`):
  - `heartbeat.ts` - Publishes runner metrics to Redis every 30s (`runner:heartbeat:{runnerId}`, TTL 90s)
  - `proxy-resolver.ts` / `proxy-crypto.ts` - Three-tier proxy resolution (actor → user → platform) with AES-256-GCM credential decryption (`PROXY_ENCRYPTION_KEY`, required in production)
  - `webhook-template.ts` - Webhook payload templating + retry processor (KEEP-IN-SYNC copy of the API's `webhooks/apply-template.ts`)
  - `wait.ts` - Readiness/wait helpers

### Database Schema

Key tables (see `packages/api/src/db/migrate.ts`):

- `actors` - Actor definitions with versioning
- `runs` - Run metadata and status
- `datasets` - Dataset metadata (items in S3)
- `key_value_stores` - KV store metadata (values in S3)
- `request_queues` - Queue metadata
- `requests` - Individual queue requests with distributed locking (`locked_until`, `locked_by`)
- `actor_versions` - Docker image versions
- `actor_builds` - Build history
- `users` - User accounts
- `api_keys` - API authentication keys
- `webhooks` - Event webhooks
- `webhook_deliveries` - Webhook delivery attempts and retry state
- `schedules` - Cron schedules for actor runs
- `retention_tombstones` - Markers for retention-deleted resources

### CLI (packages/cli)

Commands:

- `login` - Authenticate with platform
- `push` - Package and upload Actor (name always comes from `.actor/actor.json`; no positional arg)
- `run` - Start Actor run
- `call` - Run Actor and wait for completion
- `logs` - Stream real-time logs
- `init` - Initialize a new Actor project
- `dev` - Run Actor locally in development mode
- `status` - Show platform and Actor status
- `list` (alias `ls`) - List actors and runs
- `info` - Show current profile/connection info
- `profile` - Manage named auth profiles (`list`/`use`/`rm`)

Configuration stored in `~/.crawlee-cloud/config.json`

## Configuration

Environment variables are defined in `.env.example` (basic) and `.env.secure.example` (security-focused). Key variables:

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` - S3-compatible storage
- `API_SECRET` - Internal API authentication
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` - Initial admin user setup
- `PORT` - API server port (default: 3000)

## Development Patterns

### Adding New API Endpoints

1. Create Zod validation schema in `packages/api/src/schemas/`
2. Create route handler in `packages/api/src/routes/`, importing the schema
3. Register route in `packages/api/src/index.ts` with `/v2` prefix
4. Follow Apify API response format for compatibility

### Database Changes

1. Update schema in `packages/api/src/db/migrate.ts`
2. Run `npm run db:migrate` to apply changes
3. Schema is idempotent (uses `IF NOT EXISTS`)

### Testing

Tests use Vitest with workspace configuration:

- API tests located in `packages/api/test/`
- Each test file mocks the auth middleware with `vi.mock` before route imports
- Integration tests may require Docker infrastructure

### Type Safety

- TypeScript strict mode enabled
- ESLint with `typescript-eslint` recommended rules
- Some rules relaxed for practical development (see `eslint.config.mjs`)
- Use `@typescript-eslint/consistent-type-imports` for type-only imports

## Apify SDK Compatibility

Actors use standard Apify SDK with environment variable overrides:

- `APIFY_API_BASE_URL` - Points to local API server
- `APIFY_TOKEN` - User's API key
- `APIFY_ACTOR_RUN_ID` - Current run ID
- `APIFY_DEFAULT_DATASET_ID` - Default dataset for `Actor.pushData()`
- `APIFY_DEFAULT_KEY_VALUE_STORE_ID` - Default KV store
- `APIFY_DEFAULT_REQUEST_QUEUE_ID` - Default request queue

## Key Implementation Details

### Request Queue Locking

Request queues use PostgreSQL row-level locking for distributed crawling:

- `locked_until` timestamp prevents multiple workers from processing same request
- `locked_by` tracks which worker holds the lock
- `FOR UPDATE SKIP LOCKED` prevents deadlocks

### Deduplication

Request deduplication via unique constraint on `(queue_id, unique_key)`:

- `unique_key` is hash of URL + method + other parameters
- Prevents duplicate requests in queue automatically

### Storage Architecture

Hybrid storage model:

- Metadata in PostgreSQL (fast queries, transactions)
- Large objects in S3 (scalable, cost-effective)
- Logs in Redis (fast writes, automatic expiration)

### ID Generation

Uses short, human-friendly IDs (nanoid, 21 chars) instead of UUIDs, matching Apify's style.
