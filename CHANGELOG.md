# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.9.1] - 2026-05-03

### Added

- **Apify-compatible webhook payload templating engine.** Custom `payload_template` strings now support both forms Apify documents — `"{{eventData}}"` (quoted, the entire string-cell is the variable) and `{{eventData}}` (unquoted, sits as a JSON value) — plus mid-string interpolation (`"text {{userId}} more"`) and dot-notation lookup (`{{eventData.actorRunId}}`, `{{resource.stats.runTimeSecs}}`). Substitution is now against the camelCase Apify-shape payload, not the raw snake_case run row, so templates copied from Apify's docs work unchanged. Implementation: a small character-walker tracks JSON-string state, replaces each `{{...}}` with a sentinel (bare inside strings, JSON-encoded in value position), then JSON.parses and walks the tree to substitute typed values. Engine duplicated in `packages/api/src/webhooks/apply-template.ts` and `packages/runner/src/webhook-template.ts` with `KEEP IN SYNC` headers + 16 + 10 mirrored unit tests; consolidation into a shared workspace lands in v1.0.
- **Test webhook now applies the user's template.** `POST /v2/webhooks/:id/test` previously sent the default Apify-shape payload regardless of the user's `payload_template`. Operators could pass the test webhook and discover production was mangling the template only later. The test endpoint now runs the same engine production deliveries do, so dashboard "test webhook" exercises identical bytes to receivers.
- **Server-side substring search** via `?q=<text>` on `/v2/{acts,datasets,key-value-stores,request-queues,schedules,webhooks}`. ILIKE on `(id, name)` for most resources; actors also search `title, description`; webhooks search `(id, description, request_url)` since they have no `name` column. User-typed LIKE metacharacters (`%`, `_`, `\`) are escaped via a small helper so `?q=100%25` matches the literal string `"100%"` rather than everything. Empty/whitespace `?q=` skips the WHERE clause so the index-only path stays cheap on no-op searches.
- **Dashboard search now hits the API.** The four list pages with existing search inputs (actors, datasets, KV stores, request queues) drop their client-side `Array.filter` (which only filtered the visible 50 rows) and route through the new `?q=` URL param. New `useDebouncedSearch` hook (300 ms) keeps typing responsive without firing a fetch on every keystroke. Setting a new query resets `?page=` so a narrowing search doesn't strand the user on a now-out-of-range page. Search state lives in the URL alongside `?page=` — bookmarkable, shareable, browser back works.
- **Stress-test fixture script** at `scripts/seed-stress-fixtures.ts` — bulk-inserts 5,000 each of unnamed datasets / KV / queues / runs plus 200 actors / 100 schedules / 100 webhooks via `generate_series` for QA at scale. Idempotent on re-run; `--teardown` removes everything with the `stress-` prefix in one pass.

### Fixed

- **Reaper no longer reaps actively-written-to unnamed resources.** v0.9.0's `reap*` predicates only checked `accessed_at`, but data-write paths (`POST /datasets/:id/items`, `PUT /key-value-stores/:id/records/:key`, request-queue mutations) bump `modified_at` only. So an actor pushing data into an unnamed dataset for 31 days could see the dataset reaped while writes were still landing. Each reap predicate now uses `GREATEST(accessed_at, modified_at) < NOW() - $1::int * INTERVAL '1 day'`, which fixes the gap in one place rather than retrofitting every writer.
- **Dashboard counter tiles report the real total** rather than `items.length` capped at 1000. The home dashboard's "Actors" and "Datasets" tiles previously called `getActors({ limit: 1000 })` then reported `actors.items.length` — silently undercounting any tenant past 1,000. They now read `actors.total` from the API's parallel `COUNT(*)`, and the `limit: 1` request makes the call cheaper since the items are unused.

### Changed

- **Search-condition helper extracted to `packages/api/src/db/search.ts`.** The five-line ILIKE clause builder was duplicated across all six list routes; bot-review suggested centralizing. New `appendSearchCondition(where, params, q, columns)` mutates `params` and returns the new WHERE — each route now passes only its searchable columns.

### Tests

- 16 webhook-template engine cases on the api side + 10 on the runner side. Cover both Apify-doc forms (quoted lone-cell, unquoted value-position), mixed quoted/unquoted in one template, mid-string interpolation, dot notation, missing keys (lone → `null`, interpolation → `""`), and invalid-template fallback.
- 6 cases for `escapeLikePattern`, 4 cases for `?q=` on actors, 1 for webhooks (different searchable columns).

## [0.9.0] - 2026-05-03

### Added

- **Retention reaper**: a periodic in-process job that cleans up unnamed datasets, key-value stores, request queues, and finished runs past TTL — the "platform survives months of operation" gating concern. Each tick acquires a Postgres advisory lock on a pinned `pool.connect()` client, runs five SQL phases (runs → datasets → KV → queues → tombstone-prune) bounded by `RETENTION_BATCH_SIZE`, releases the lock, then performs S3 prefix deletion with bounded concurrency. CTE-with-recheck pattern keeps DELETE + tombstone INSERT atomic. New env vars: `RETENTION_ENABLED` (default `true`), `RETENTION_DAYS` (default `30`), `RETENTION_TOMBSTONE_DAYS` (default `365`), `RETENTION_BATCH_SIZE` (default `500`), `RETENTION_CRON` (default `0 3 * * *`).
- **`retention_tombstones` audit table** — every reaped row leaves a tombstone with kind, id, name, user, reason, and original creation timestamp before being pruned at `RETENTION_TOMBSTONE_DAYS`.
- **`GET /v2/system/retention/status`** (admin-only) returns reaper config, last-tick timestamp/elapsed, last-24h reap counts, and live tombstone row count. Backed by Redis tick-stats (cheap to read) plus a single COUNT(\*) over `retention_tombstones`.
- **Dashboard retention status page** at `/retention` with auto-refresh every 30s — surfaces whether the reaper is running, when it last ticked, and what it pruned.
- **Pagination on six dashboard list pages** (actors, datasets, KV stores, request queues, schedules, webhooks) at production scale. Verified against 5,029 datasets / 5,033 KV / 5,029 queues with ~5–12 ms p50 latency on first-page fetches. URL-driven via `?page=N` (1-indexed, omitted on page 1) so pages are bookmarkable, shareable, and editable in the address bar.
- **Page X / Y indicator with editable page-number input** — type a page number, Enter or blur to jump, clamped to `[1, totalPages]`. Out-of-range URLs (`?page=999` on a 12-page list) render an explicit "Page 999 doesn't exist" error with a "go to page N" CTA, distinct from the empty-state UI.
- **Stress-fixture script** (`scripts/seed-stress-fixtures.ts`) — bulk-inserts datasets/KV/queues/runs/actors/schedules/webhooks via `generate_series` for QA at scale. Idempotent on re-run; `--teardown` removes everything with the `stress-` prefix. ~5,000 rows per table land in <300 ms.
- **Deployment recipes** under `docs/deployment/`: a hobby-tier docker-compose recipe and a DigitalOcean Spaces (S3-compatible) recipe, both end-to-end runnable.

### Changed

- **`runs.default_dataset_id` / `default_key_value_store_id` / `default_request_queue_id` FKs softened to `ON DELETE SET NULL`** — previously RESTRICT, which would have blocked the reaper from deleting unnamed default storage of finished runs without a separate cascade pass.
- **Root list endpoints (`/v2/acts`, `/v2/datasets`, `/v2/key-value-stores`, `/v2/request-queues`, `/v2/schedules`, `/v2/webhooks`) now return a real Apify-shape pagination envelope** with `total` from a parallel `COUNT(*)` query, `count`/`offset`/`limit`/`items`. Previously each route hardcoded `LIMIT 100` with no offset and a fake `total = items.length`, which silently truncated for any account with >100 of the resource and made the "have I shown everything?" question unanswerable. Stable `ORDER BY created_at DESC, id DESC` tiebreaker keeps results stable across pages.
- **Dashboard centralizes constants** in `packages/dashboard/src/lib/constants.ts`: `PAGE_SIZE`, `FETCH_ALL_LIMIT`, `LOG_TAIL_LIMIT`, `DATASET_PREVIEW_LIMIT`, `KV_KEYS_PREVIEW_LIMIT`, `POLL_RETENTION_MS`, `POLL_RUNNERS_MS`, `COPY_FEEDBACK_MS`, `APP_VERSION`. Sweeps 7 inline `const LIMIT = 50`, 7 `limit: 1000` magic-number callsites, polling cadences, and the previously-hardcoded `OPERATOR · v0.1` sidebar/login label (now sourced from `package.json`).
- **Retention reaper releases the advisory lock before S3 cleanup**, not after. With `RETENTION_BATCH_SIZE=500` and ~50 ms per S3 LIST+DELETE round-trip, holding the lock through S3 would block sibling-instance DB phases for ~50 s under load — for no benefit, since the rows are already committed when each `reap*()` returns. Each `reap*()` now returns the IDs it deleted; `runReaperTick()` runs the five DB phases under the lock, releases, then runs `cleanupDatasetS3Prefixes` / `cleanupKVStoreS3Prefixes` with bounded concurrency (10).
- **Retention cron callback wraps `runReaperTick()` in `.catch()`.** `pool.connect()` runs outside any try block in the reaper, so a transient DB outage at fire time would otherwise produce an unhandled rejection — fatal under Node 20+'s default `--unhandled-rejections=throw`.

### Tests

- 20 retention integration tests covering each phase, the orchestration tick, advisory-lock contention, the FK softening, and the admin status endpoint (200 for admin, 403 for non-admin).
- 6 config-validation unit tests for the new `envCron` helper and the five retention env vars.

## [0.8.6] - 2026-05-03

### Fixed

- **CLI: `crawlee-cloud push` header now shows the registry-qualified image runners pull**, not the internal local Docker tag. Previously `--ghcr` and `CRAWLEE_CLOUD_REGISTRY_URL` flows printed `crawlee-cloud/actor-<name>:<tag>` (a Docker daemon-only tag never published anywhere) at the top of the push output, while the actual deploy target only appeared mid-stream in the push spinner. CI logs and PR screenshots showed two different images on the same screen with no indication which one the platform actually stores. The header now uses the same `runtimeImage` value that gets sent to the API as `actor.defaultRunOptions.image`.

### Infrastructure

- **`publish-cli.yml` workflow now upgrades npm to a Trusted-Publishing-capable version (>=11.5.1) before publishing.** v0.8.5's first publish attempt 404'd from npm despite a valid OIDC token because Node 20's bundled npm 10.8.2 supports the OIDC handshake for sigstore provenance signing but not for the publish-credential exchange itself, which landed in npm 11.5.1. v0.8.5 was eventually published via a one-time `workflow_dispatch` from a debug branch with the upgrade applied; v0.8.6 will be the first release to take the clean tag-driven publish path end-to-end and confirm the fix.

## [0.8.5] - 2026-05-02

### Fixed

- **API version on the dashboard and `/health` is correct on production deploys.** v0.8.4 and earlier reported `v0.0.0` (or `v1.0.0` on `/health`) when deployed on DigitalOcean App Platform, k8s containers, systemd units, or anywhere `node dist/index.js` is launched directly — `process.env.npm_package_version` is only set by `npm run *` invocations, and the previous fallback masked the missing value as a confidently-wrong version. The API now reads `package.json` from disk at module-load time via a small `version.ts` helper (`dist/version.js → ../package.json`) and serves the result on `/v2/system/info`'s `resource.version` and the legacy `GET /health`. Cached for the process lifetime; falls back to `0.0.0` only if `package.json` is genuinely unreadable (operator-spottable sentinel, not a default for normal operation).

### Documentation

- README now leads with a **Dashboard** section: hero shot of the operator console + a 3×2 grid showcasing Webhooks (test/debug UI), Run detail (live logs, runtime sidebar), Settings (live version, scaler state, storage health probes with latency), KV stores (click-to-expand inline JSON preview), Runs history, and Actors grid. ~900 KB of PNGs under `docs/screenshots/`. Helps prospective adopters evaluate the platform's maturity at a glance from the GitHub page.

### Tests

- New `packages/api/test/version.test.ts` (2 cases): asserts the helper returns the real `package.json` version (not the `0.0.0` fallback), and — using `vi.resetModules()` + dynamic import to actually exercise the load-time codepath — that the value doesn't depend on `process.env.npm_package_version`. Latter test would have caught the production bug at v0.8.0.

## [0.8.4] - 2026-05-02

### Fixed

- **`/v2/system/info` execution defaults now reflect what runners actually use, per scaler provider.** v0.8.3 sourced the panel from API-process env, which is wrong in any split deploy (API and runners on different machines): the API host typically doesn't have `MAX_CONCURRENT_RUNS` / `DEFAULT_MEMORY_MB` / `DEFAULT_TIMEOUT_SECS` set at all, so the dashboard quietly returned the fallback defaults. Now keyed on `SCALER_ENABLED`:
  - **Scaler ON** → memory/timeout come from a per-provider table (`PROVIDER_DEFAULTS` in `scaler/index.ts`) that mirrors what each provider's `createRunner` actually injects:
    - `digitalocean`: 2048 / 3600 (cloud-init writes these explicitly)
    - `local-docker`: 1024 / 3600 (matches the runner's own config fallbacks since the provider only injects `MAX_CONCURRENT_RUNS`)
    - `noop`: 1024 / 3600
    - unknown providers: 1024 / 3600 (honest fallback over a confident lie)
  - **Scaler OFF** → API env (existing behavior, correct for single-host)
- The `2048` / `3600` magic numbers in the DigitalOcean cloud-init heredoc are now `CLOUD_INIT_DEFAULT_MEMORY_MB` / `CLOUD_INIT_DEFAULT_TIMEOUT_SECS` exported constants — used in both the cloud-init template and the system route lookup so they can't drift apart.
- Dashboard "Execution Defaults" footer now reflects the active path (`scaler/cloud-init (split deploy)` vs `API process env (single-host)`) so operators can interpret the values correctly. Field hints simplified — they no longer name specific env vars that may not apply.

### Tests

- 7 system tests now exercise each provider separately: scaler-on + local-docker, scaler-on + digitalocean, scaler-on + unknown provider, scaler-off + single-host. Same bug pattern can't slip back in unnoticed.

## [0.8.3] - 2026-05-02

### Added

- **API: `GET /v2/system/info` endpoint** — aggregate the dashboard's Settings page consumes in one call: server version, Node version, live storage health probes (PostgreSQL / Redis / S3 with latency), execution defaults read from runner env (`MAX_CONCURRENT_RUNS`, `DEFAULT_MEMORY_MB`, `DEFAULT_TIMEOUT_SECS`), and a safe subset of scaler state (enabled, provider, min/max — no IPs, no tokens; full data stays admin-only at `/v2/scaler/status`). Authenticated, not admin-only.
- **Dashboard: new "Server" panel on Settings** showing live version, Node version, scaler state, and queue limits — sourced from `/v2/system/info`.
- **API: `POST /v2/webhooks/:id/test` endpoint** — fires a synthetic event at the webhook's configured URL. One shot, no retries, 10s timeout. Records the result in `webhook_deliveries` so the test attempt shows up in the same history operators already inspect. Payload mirrors the production format but sets `test: true` and uses sentinel run IDs so receivers can opt out of side effects. Returns the delivery row synchronously — UI shows the outcome without polling. Reuses the same private-URL SSRF guard as the runner.
- **Dashboard: webhook test/debug UI on the Webhooks page**:
  - **Test button** on each row fires the new endpoint and toasts the result.
  - **Log button** expands a Deliveries drawer with the last N attempts: status badge, event type, HTTP code, attempt count, age, response/error body, next retry timestamp.
  - **Last-seen indicator** on each row shows status of the most recent delivery once the drawer has been opened (green / red / muted dot).

### Fixed

- **Runner: macOS auto-translate warning is now visible in real time.** Previously the `[Runner] Rewriting actor APIFY_API_BASE_URL host -> host.docker.internal ...` warning was emitted via `console.warn`, which Node line-buffers when stderr is piped to a file (the `npm run start > log 2>&1` case). The warning sat in a buffer until the process exited, so operators triaging a stuck dev setup never saw it during normal operation. Switched to `process.stderr.write(...)`, which Node treats as synchronous on file descriptors and flushes immediately.
- **Runner: removed duplicate `Starting run processor...` boot log.** Both `index.ts` and `queue.ts:startProcessing()` were logging the same line, producing two consecutive identical entries on every boot. Kept the one inside `startProcessing()` since it's closer to the action it announces.
- **Dashboard: Storage Backends section no longer lies.** Previously rendered a hard-coded list of three backends (`PostgreSQL` / `Redis` / `MinIO`) all unconditionally tagged `connected`, regardless of whether the underlying service was reachable. Now reads live `storage` health from `/v2/system/info` and shows `connected` (with latency), `down` (with the failure reason on hover), or `checking` while the request is in flight.
- **Dashboard: Execution Defaults are now real.** The three input fields (concurrency, memory, timeout) previously rendered hard-coded JSX literals (`defaultValue={10}`, `{1024}`, `{3600}`) regardless of server config — the footer text claimed "server-driven values" but they came from nowhere. Now read from `/v2/system/info`'s `executionDefaults`, sourced from `MAX_CONCURRENT_RUNS` / `DEFAULT_MEMORY_MB` / `DEFAULT_TIMEOUT_SECS` env vars. Read-only; stays read-only — these stay env-var-driven for now (writeable defaults would need a settings store and admin-only mutation route).
- **API: `GET /v2/auth/api-keys` now returns camelCase fields.** Previously the route returned raw Postgres rows (`is_active`, `key_preview`, `last_used_at`), but the dashboard's `ApiKey` interface — and the rest of the API surface — uses camelCase. Result: `apiKeys.filter(k => k.isActive)` evaluated to `[]` for every key, hiding every active token from the Settings page. The list is now mapped through the same camelCase shape `formatWebhook`/`formatDelivery` use.
- **Dashboard: `getWebhookDeliveries()` now hits the right URL.** The helper was calling `/v2/webhooks/:id/dispatches` (wrong path) and silently catching the 404 to return `[]`, which made the deliveries list permanently empty even when records existed. Path corrected to `/v2/webhooks/:id/deliveries` and the swallowed try/catch removed so failures surface.
- **Dashboard: `WebhookDelivery` type now matches what the API actually returns.** Previously declared `statusCode` / `errorMessage` / `deliveredAt` — fields the API never returned. Real shape is `status` (PENDING/DELIVERED/FAILED), `attemptCount`, `maxAttempts`, `nextRetryAt`, `responseStatus`, `responseBody`, `finishedAt`. Locked into the type so the new drawer renders real values instead of `undefined`.

### Refactored

- `packages/api/src/health.ts`: extracted `runStorageHealthChecks()` and `StorageHealth` type so `/health/ready` (k8s probe) and `/v2/system/info` (dashboard) share one implementation. Single source of truth for what "healthy" means across surfaces.

### Verified

- Re-ran the local smoke test against the cuponation actor with `API_BASE_URL=http://localhost:3000` (the bad value the auto-translate is meant to handle). Warning now appears in `/tmp/crc-runner.log` on the next run, before the container is created. Run completed `SUCCEEDED` with the actor reaching the host API via `host.docker.internal`.

## [0.8.2] - 2026-05-02

### Fixed

- **Runner: actor containers can now reach a host-running API on macOS dev setups.** When the runner runs on the host (the default `npm run dev` flow on a Mac) and spawns an actor container with `APIFY_API_BASE_URL=http://localhost:3000`, the actor previously failed because `localhost` inside the container is the container itself, not the host. The runner now auto-translates `localhost` and `127.0.0.1` to `host.docker.internal` on `os.platform() === 'darwin'` only — Linux is untouched, since `host.docker.internal` doesn't resolve there by default and production Linux deploys typically use a real service hostname. A one-time warning logs the rewrite so operators understand what's happening.
- **Scaler: heartbeats now match by runner _name_ as a fallback, not just _id_.** Cloud-init can't always set `RUNNER_ID` to the provider id at boot (curl to the metadata service can fail, or the user-data path is racy). When that happens, the runner publishes its heartbeat keyed on `os.hostname()` — which providers typically set to the runner _name_ (DO droplet name, local-docker container name), not the id. Previously the scaler matched only by id and ip, so every healthy runner was marked dead after the reaper threshold and destroyed. Lookup is now `id → ip → name`. The DO cloud-init also opportunistically queries the metadata service for the droplet id and writes `RUNNER_ID=<id>` so the primary match works whenever the metadata fetch succeeds.
- **Local-docker provider: strip the leading `/` from container names** so the value matches what `os.hostname()` returns inside the container (Docker prefixes `Names[0]` with `/`).

### Added

- **API: `GET /v2/actor-runs/:runId/log` (Apify-compat alias).** Returns the same plain-text payload as the canonical `/logs/raw` route. Apify's documented public endpoint is the singular form; tools like `apify-client` and curl scripts targeting `api.apify.com` now work unchanged when pointed at a self-hosted instance.

### Documentation

- `.env.example` now covers `API_BASE_URL` with explicit guidance for macOS dev (auto-translation), docker-compose (service name), and production (public DNS).

### Tests

- Added `packages/runner/test/translate.test.ts` covering Darwin auto-translation, Linux pass-through, and non-loopback hosts. Runner package now has a `test` script wired to vitest.
- Added `/log` alias coverage in `packages/api/test/logs.test.ts` — verifies it returns identical bytes to `/logs/raw` and shares the same ownership 404 gate.

## [0.8.1] - 2026-05-01

### Security

- **Scaler: TLS verification is no longer disabled by default on provisioned runners.** Previously `NODE_TLS_REJECT_UNAUTHORIZED=0` was hard-coded into the cloud-init script, making every outbound HTTPS call from a runner (API, S3, registries, actor scraping) MITM-vulnerable. The bypass is now opt-in via `SCALER_INSECURE_TLS=true`, and the API logs a startup warning when set. Operators relying on internal CAs / self-signed certs must explicitly opt in; otherwise upgrade is transparent.
- Documented the cloud-init userData secret-exposure caveat: on `digitalocean` provider, `DATABASE_URL`, `REDIS_URL`, and registry tokens are inlined into user_data and readable from the DO metadata service by anything running on the VM. Tracked for an architectural fix in a future release; documented today so operators can apply network-level mitigations.

### Performance

- Replaced `redis.keys('runner:heartbeat:*')` with cursor-based `SCAN` in both `getActiveRunners` and `getScalerStatus`. `KEYS` is O(N) over the entire keyspace and blocks the Redis event loop — fine in tests, lethal on a shared Redis at scale.

### Fixed

- Scaler no longer over-provisions on transient `provider.listRunners()` failures. Previously the error was swallowed and an empty list returned, causing the scaler to think capacity was zero and create duplicate runners on the next tick. Errors now propagate to the loop's catch block, which logs and skips the tick.
- `loadScalerConfig` rejects non-finite integer env vars (e.g. `SCALER_MAX_RUNNERS=abc`) and falls back to defaults instead of producing `NaN` and silently breaking comparisons. `MAX_RUNNERS` is also clamped to `>= MIN_RUNNERS`.
- `LAST_ACTIVITY_KEY` now has a TTL (4× `idleTimeoutSecs`) so it ages out of Redis if the scaler is later disabled, rather than living forever.
- `RUNNERS_KEY` TTL adapts to `pollIntervalSecs` (`max(120, pollIntervalSecs * 4)`). Previously hard-coded to 120s, which caused `getScalerStatus` to report an empty runner list when the poll interval exceeded 30s.

### Documentation

- Added an Auto-scaling section to `docs/runner.md` covering every `SCALER_*` env var, provider matrix, and operational notes.
- `.env.example` and `.env.secure.example` now document the full scaler config surface, with `SCALER_INSECURE_TLS` and `METRICS_PUBLIC` flagged as security opt-outs.

## [0.8.0] - 2026-05-01

### Breaking

- `GET /metrics` is now admin-only by default. Previously unauthenticated, the endpoint exposed process internals and per-route HTTP counters useful for fingerprinting a deployment. Self-hosted operators scraping `/metrics` with Prometheus must update their scrape config to send an admin JWT (or admin API key) in the `Authorization: Bearer ...` header. `/health`, `/health/live`, and `/health/ready` remain unauthenticated for k8s probes. Set `METRICS_PUBLIC=true` to opt out (see Added below).
- `GET /v2/scaler/status` is now admin-only with no opt-out — the response includes runner IPs, cloud provider, and scaler config that have no public use case.

### Added

- **Auto-scaling**: new `local-docker` scaler provider for development and small self-hosted setups; reaper sweeps dead runners; image registry support (GHCR, Docker Hub) so new runners pull actor images on demand instead of requiring a local build.
- **Build versioning**: actor versions and builds are tracked separately, with a partial unique index on `actor_versions(actor_id, build_tag)` to allow multiple builds per tag while keeping the active one unique.
- **Run pagination**: scale-aware, stable pagination for run listings — keyset-based, holds steady under high write volume.
- **CLI profiles**: `crc login --profile <name>` saves named credential sets; `crc profile list/use/rm` and `CRAWLEE_CLOUD_PROFILE=...` env override let you switch between local/staging/prod without re-logging-in.
- **CLI `crc info`**: shows active profile, API URL, server reachability, and authenticated user. Exits non-zero on failure — usable as a CI gate.
- **Actor default env vars and image** in `defaultRunOptions` — set per-actor defaults that apply to every run unless overridden at run time.
- **Dashboard pages**: Builds, Schedules, Webhooks, Request Queues, Runners, Key-Value Store browser, mobile nav, toast/dialog/confirm UI primitives.
- `METRICS_PUBLIC` env var (default `false`) — opt-in escape hatch for operators running Prometheus on a private network where the scrape job can't pass an `Authorization` header. When `METRICS_PUBLIC=true` and `NODE_ENV=production`, the API logs a startup warning. There is intentionally no equivalent flag for `/v2/scaler/status`.

### Changed

- Documentation moved from the website repo to `docs/` in this repo as the source of truth, with sync to the public site.
- Dashboard migrated to Tailwind v4 utility names (`bg-signal`, `text-fail`, ...) and a unified warm-orange `--signal` color across themes.
- ESLint: pedantic rules softened, real-bug rules kept strict.

### Fixed

- `apify-client` 404 contract: API responses now include `error.type='record-not-found'` so `catchNotFoundOrThrow` correctly falls through to `getOrCreate`.
- Runner API key is regenerated when bound to a stale user, fixing a 404-on-own-storage failure mode after admin changes.
- `PUT /v2/acts/:id` now persists `defaultRunOptions`, `maxRetries`, and `retryDelaySecs` correctly.
- Dataset items return type narrowed at the consumer rather than the helper, unblocking dashboard CI.
- Runner prefixes `actor-` when pulling from a configured registry, matching the build naming convention.

## [0.1.0] - 2025-12-14

### Added

#### Infrastructure (Sep 28)

- Docker Compose orchestration for PostgreSQL, Redis, and MinIO
- Separate dev and production configurations
- Dockerfiles for API, Runner, and Actor base images

#### API Server (Oct 5 - Oct 18)

- Fastify server with Apify-compatible REST API
- Dataset CRUD operations (`/v2/datasets`)
- Key-value store support (`/v2/key-value-stores`)
- Request queue with deduplication (`/v2/request-queues`)
- Actor management routes (`/v2/acts`)
- Run execution and status (`/v2/actor-runs`)
- JWT authentication system
- PostgreSQL integration for metadata
- Redis for distributed locking
- S3-compatible blob storage

#### Runner (Oct 26)

- Docker-based Actor execution
- Job queue polling from Redis
- Container lifecycle management
- Log streaming to API
- Resource limits and graceful shutdown

#### Dashboard (Nov 9 - Dec 6)

- Next.js application with App Router
- Actor listing and management UI
- Run execution with live logs
- Dataset browser
- Settings page
- Responsive sidebar navigation

#### CLI (Nov 22)

- `crawlee-cloud login` - Server authentication
- `crawlee-cloud push` - Push Actors to registry
- `crawlee-cloud run` - Execute Actors with input
- `crawlee-cloud logs` - Real-time log streaming

#### Documentation (Dec 13)

- Complete API reference
- CLI usage guide
- Dashboard overview
- Deployment instructions
- Runner configuration guide

### Features

- WebSocket streaming for real-time logs
- Request queue deduplication by `uniqueKey`
- Distributed locking for multiple workers
- Cloud-agnostic S3-compatible storage
