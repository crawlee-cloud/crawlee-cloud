# Roadmap

A CLI-first platform for running large-scale scrapers on your own infrastructure.

## Current Version: v1.6.0

- Runner disk-pressure protection: claim gate at `RUNNER_DISK_CLAIM_MAX_PCT`, registry-scoped image eviction at `RUNNER_DISK_EVICT_PCT`, infra retry floor for pull failures
- `GET /v2/datasets/:id/items` without `limit` streams the full dataset (Apify parity; was silently truncated to 100)
- Community feedback funnels (issue templates, deployment reports, CLI post-push note) and a fixed npm publish pipeline
- Safe actor force-deletion, SSRF loopback fixes, CI coverage floors (v1.5.0)

The 1.0 stability commitment (2026-06-06) is well behind us. The 1.x line has focused on production reliability (runner lifecycle races in v1.0.1, zombie-run reaping in v1.1.0, memory-aware placement in v1.2.0, disk-pressure protection in v1.6.0), cost visibility (v1.3.0–v1.4.0), and hardening (v1.5.0) — all additive, as the semver commitment requires.

---

## Proposed — RFC open

Not committed to a version yet — each has an open discussion gathering input before implementation is scoped:

- **Official Python actor support** — Python actors already run today (the runner is Docker-image-based, and `crc init`/`crc dev` handle Python templates); this makes it official with docs, curated templates, and SDK-compat verification. [Join the RFC →](https://github.com/orgs/crawlee-cloud/discussions/95)
- **Platform MCP server** — let AI agents (Claude, Cursor, …) run actors, check runs, and fetch datasets on your instance via the Model Context Protocol. TypeScript, against the platform as it is today. [Join the RFC →](https://github.com/orgs/crawlee-cloud/discussions/96)

---

## v0.1.0 ✅

- Initial Apify-compatible REST API
- Docker-based Actor execution
- CLI basics (`crc push`, `crc run`, `crc logs`)
- Datasets, Key-Value Stores, Request Queues
- Basic web dashboard

## v0.2.0 ✅

- `crc init` — Scaffold new Actor projects from templates
- `crc dev` — Local development mode with hot reload
- `crc status` — Check run status and resource usage
- Environment variable support (`-e` flag)
- Improved error messages
- Security hardening (input validation, config validation, CORS)

---

## v0.3.0 ✅ — Production Scraping at Scale

| Feature         | Status                                            |
| --------------- | ------------------------------------------------- |
| Cron scheduling | ✅ Shipped — schedules table + scheduler service  |
| Retry policies  | ✅ Shipped — configurable max retries and backoff |
| Run timeouts    | ✅ Shipped — container timeout enforcement        |
| Webhooks        | ✅ Shipped — webhook deliveries with retry logic  |
| Resource limits | ✅ Shipped — memory limits per container          |

## v0.4.0 ✅ — Reliability & Operations

| Feature           | Status                                                          |
| ----------------- | --------------------------------------------------------------- |
| Metrics           | ✅ Shipped — Prometheus /metrics endpoint                       |
| Health checks     | ✅ Shipped — /health endpoint                                   |
| Graceful shutdown | ✅ Shipped — SIGTERM/SIGINT handlers in API and runner          |
| Backup & restore  | ✅ Shipped — backup:create, backup:restore, backup:list scripts |

## v0.5.0 ✅ — Security & Polish

| Feature                    | Status                                              |
| -------------------------- | --------------------------------------------------- |
| Auth middleware            | ✅ Shipped — JWT + API key authentication           |
| User-scoped resources      | ✅ Shipped — IDOR protection                        |
| Input validation           | ✅ Shipped — Zod schemas on all endpoints           |
| SSRF protection            | ✅ Shipped — webhook URL validation                 |
| Security config validation | ✅ Shipped — blocks insecure defaults in production |

## v0.6.0 ✅ — Cloud Deployment & Auto-Scaling

| Feature                 | Status                                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| DigitalOcean deployment | ✅ Shipped — App Platform (API + Dashboard) + Runner Droplet           |
| Setup automation        | ✅ Shipped — `bash deploy/digitalocean/setup.sh` provisions everything |
| One-click deploy        | ✅ Shipped — Railway, Render, DigitalOcean buttons                     |
| Runner auto-scaler      | ✅ Shipped — queue-based, platform-agnostic (DO provider)              |
| Runner heartbeat        | ✅ Shipped — CPU/memory/disk metrics via Redis                         |
| Dashboard path routing  | ✅ Shipped — works behind path-stripping reverse proxies               |
| SSL for managed DBs     | ✅ Shipped — auto-enables for production Postgres                      |
| Auto-migrations         | ✅ Shipped — `run_command` runs migrations before API starts           |

## v0.7.0 ✅ — Image Registry & Runner Cleanup

| Feature                 | Status                                                          |
| ----------------------- | --------------------------------------------------------------- |
| GHCR image registry     | ✅ Shipped — push actor images to GitHub Container Registry     |
| DO Spaces integration   | ✅ Shipped — managed S3-compatible storage in addition to MinIO |
| Runner image cleanup    | ✅ Shipped — runners prune old images so disks don't fill up    |
| Custom registry support | ✅ Shipped — `CRAWLEE_CLOUD_REGISTRY_URL` env var               |

## v0.8.0 → v0.8.6 ✅ — Production-Hardening Cycle

A rapid patch cycle driven by what showed up under real load.

| Version | Headline                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| v0.8.0  | Race-free dataset push (`UPDATE … RETURNING`); queue dedup hot path; pool-ceiling backpressure               |
| v0.8.1  | Scaler security & reliability patch (clamping, idempotent provider calls, SIGTERM grace)                     |
| v0.8.2  | macOS dev reachability (host.docker.internal); scaler heartbeat resilience under network blips               |
| v0.8.3  | Webhook test/debug UI; real Settings panel; rich payload shape                                               |
| v0.8.4  | `/v2/system/info` execution defaults reflect runner config per-provider, not API env                         |
| v0.8.5  | Honest API version on `/health` and dashboard (read from `package.json` at module-load instead of stale env) |
| v0.8.6  | CLI `push` header shows the registry-qualified image; `publish-cli.yml` upgrades npm before publishing       |

## v0.9.0 ✅ — Retention Reaper + Pagination at Scale

The "platform survives months of operation" gate.

| Feature                       | Status                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| Retention reaper              | ✅ Shipped — periodic cleanup of unnamed datasets/KV/queues + finished runs past TTL                |
| `retention_tombstones` audit  | ✅ Shipped — every reaped row leaves a tombstone before being pruned at `RETENTION_TOMBSTONE_DAYS`  |
| Admin retention status        | ✅ Shipped — `GET /v2/system/retention/status` + dashboard `/retention` page (auto-refresh 30s)     |
| Real list-endpoint pagination | ✅ Shipped — `total` from parallel `COUNT(*)`, stable `created_at DESC, id DESC` tiebreaker         |
| Dashboard pagination UI       | ✅ Shipped — URL-driven `?page=N`, "Page X / Y" with editable page input, out-of-range error        |
| Constants centralized         | ✅ Shipped — `packages/dashboard/src/lib/constants.ts`; sidebar version sourced from `package.json` |
| Deployment recipes            | ✅ Shipped — hobby docker-compose + DigitalOcean Spaces                                             |

## v0.9.1 ✅ — Webhook Templating + Server-Side Search

| Feature                                          | Status                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Apify-compatible webhook engine                  | ✅ Shipped — both `"{{x}}"` quoted and `{{x}}` unquoted forms; interpolation; dot notation |
| Test webhook applies template                    | ✅ Shipped — `POST /v2/webhooks/:id/test` runs the same engine as production deliveries    |
| Server-side `?q=` search                         | ✅ Shipped — ILIKE substring on every list endpoint, LIKE-metachar escape                  |
| Reaper uses `GREATEST(accessed_at, modified_at)` | ✅ Shipped — actively-written-to unnamed resources no longer false-reaped                  |
| Dashboard counts real total                      | ✅ Shipped — counter tiles read `COUNT(*)`, not `items.length` capped at 1000              |
| Stress-fixture script                            | ✅ Shipped — `scripts/seed-stress-fixtures.ts` for at-scale QA                             |

## v0.9.x patch line ✅

The 0.9.x line was the run-up to 1.0. Highlights:

| Release | Headline                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.9.4  | Apify proxy support (`useApifyProxy=true`) end-to-end; `PROXY_ENCRYPTION_KEY` plumbing.                                                        |
| v0.9.5  | Scaler-provisioned runners inherit `PROXY_ENCRYPTION_KEY` via cloud-init.                                                                      |
| v0.9.6  | `RUNNER_CLONE_REF` operator knob pins scaler-provisioned runners to a specific clone ref (shell-injection hardened).                           |
| v0.9.7  | API multi-replica safety via Postgres advisory-lock leader election; poll-based scheduler; actor `default_run_options` propagated to runs.     |
| v0.9.8  | `crc push` now forwards `actor.json` `defaultRunOptions` (timeoutSecs / memoryMbytes / build) — fixes the "scraper stuck at 3600s" report.     |
| v0.9.9  | Autoscaler scale-down freeze fix: math + heartbeat / `started_at` correlation against zombie RUNNING rows. Semantic `--ok` green colour token. |

---

## v1.0.0 — Stability commitment ✅ (2026-06-06)

**v1.0.0 cut on 2026-06-06 via PR #53.** The first release where breaking changes cost a MAJOR bump.

**Committed surfaces:**

- Apify v2 API endpoints (run / dataset / KV / queue / build / webhook) and their response shapes
- `crc` CLI commands (`push | run | call | logs | init | dev | status`)
- Operator env vars documented in `.env.example` and `.env.secure.example`

**Not committed** (still free to change without MAJOR): internal helpers, undocumented endpoints, scaler internals, dashboard structure.

The 1.0-launch PR was deliberately small (live dataset item counts on the runs grid + 5s auto-refresh + semantic-green success colour); most of the 1.0-worthy substance shipped across 0.9.x — see the patch-line summary above.

### Deferred from the 1.0 push (status as of v1.6.0)

The original 1.0 wish-list had more on it than shipped. Status of the deferred items:

| Area                                                    | Why it's still open                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` workspace                             | `applyWebhookTemplate` engine is duplicated in api+runner with KEEP-IN-SYNC headers. Land before v2.0 to keep options open for breaking the engine API. |
| Apify v2 API drift audit                                | Periodic compatibility check against current Apify, especially as their own surface evolves. Triggers v1.x minors as gaps are closed additively.        |
| ~~Zombie RUNNING row reaper~~                           | ✅ Shipped in v1.1.0 — dedicated periodic reaper flips orphaned RUNNING rows past their own timeout to `TIMED-OUT`, with transactional webhook enqueue. |
| DigitalOcean `listRunners` pagination                   | Provider's `per_page=100` with no iteration; deployments with >100 droplets silently underreport capacity. Still open as of v1.6.0.                     |
| Webhook `payload_template` examples in dashboard editor | Operators still consult Apify docs to discover `{{eventData}}` syntax. UX-only, no contract change — v1.x minor.                                        |
| Auth/role surface tightening                            | Admin scopes, API key TTLs. Anything role-related that breaks tokens is a v2.0 candidate; anything additive can land in v1.x.                           |

---

## v1.0.1 ✅ — Runner Lifecycle Races & Dashboard Correctness (2026-07-06)

- Resurrect actually executes (sets `READY`, clears stale exit state, publishes `run:new`); abort actually stops the container (`run:abort` channel, pull/create race windows covered)
- Run claiming is atomic (single `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`); webhook retries no longer double-deliver across runners; per-run timer leak fixed
- Dashboard: server-side actor-run filtering, poll-tick over-fetch fixes, sign-out clears the auth cookie

## v1.1.0 ✅ — Zombie-Run Reaper & OOM Visibility (2026-07-15)

- Zombie-run reaper: unclaimed RUNNING rows past their own timeout flip to `TIMED-OUT`, with the terminal UPDATE and `ACTOR.RUN.TIMED_OUT` webhook enqueue in one transaction; zombies no longer count as scaling demand
- Dead-runner detection survives Redis blips (consecutive-miss + time-window condemnation instead of a single-tick destroy)
- OOM kills are visible (`State.OOMKilled`), `status_message` set on every terminal update, failed-run logs archived to KV as `RUN_LOG.txt`
- Prebuilt runner image boot (`RUNNER_IMAGE`) removes the ~4.5-minute cold-boot penalty per scale-up

## v1.1.1 ✅ — Reaped-Run Deadline Stamping (2026-07-15)

- Reaped zombie runs stamp `finished_at` at their own deadline (`started_at + timeout_secs`) instead of the reap moment, matching Apify timed-out semantics

## v1.2.0 ✅ — Memory-Aware Placement (2026-07-16)

- Claim-time admission by host memory headroom; container limits clamped to host capacity; scaler demand in droplet-shares with starvation protection on both sides
- Fast dead-runner reap via the claim-time `runner_id` stamp; log/pull hardening; cost-attribution groundwork (`runner_price_hourly`, `peak_memory_mb`)

## v1.2.1 / v1.2.2 ✅ — Auth Hot Path & Runner-Key Self-Heal (2026-07-18)

- v1.2.1: bcrypt removed from the ingest hot path (verified-key cache + sha256-indexed API-key lookup)
- v1.2.2: runner-key split-brain self-heals on boot

## v1.3.0 / v1.3.1 ✅ — Run Cost Analysis (2026-07-19)

- `GET /v2/actor-runs/:runId/cost`: actual-overlap droplet-hour attribution, Apify compute-unit estimate, $/1k-items normalization; dashboard Cost Analysis card. Read-only and additive
- v1.3.1: Started column shows `startedAt` (READY runs read "queued"); resurrect clears `started_at`

## v1.4.0 ✅ — Per-Run Cost in the Runs List (2026-07-19)

- Batch `GET /v2/actor-runs/costs?ids=...` (up to 50 runs, two set-based queries); shared `computeYourCostUsd()` so single-run and batch paths can't drift; dashboard Cost column with client-side caching and 50-id chunking

## v1.5.0 ✅ — Safe Actor Force-Deletion & Hardening (2026-07-26)

- `DELETE /v2/acts/:actorId` refuses while runs exist (409 `actor-has-runs`); `?force=true` transactionally deletes the actor with its terminated runs and webhook deliveries — active runs always block
- Webhook SSRF guard closes the `127.0.0.0/8` and bracketed-IPv6 (`[::1]`) loopback bypasses
- Enforced per-package test-coverage floors in CI, with new runner, api, cli, and dashboard suites

## v1.6.0 ✅ — Runner Disk-Pressure Protection & Dataset Read Parity (2026-08-05)

- Disk admission gate: at `RUNNER_DISK_CLAIM_MAX_PCT` (default 90%) the runner stops claiming so a disk-full host can't fast-fail the READY queue while hiding demand from the scaler (from a live incident: 104 failed runs on two 100%-full disks)
- Registry-scoped image eviction at `RUNNER_DISK_EVICT_PCT` (default 80%): unused tags under the `IMAGE_REGISTRY` prefix only — the images with a guaranteed re-pull path; locally built images are never evicted
- Infra retry floor: pull failures and missing-image errors retry on a small platform floor even when the actor's retries are disabled
- `GET /v2/datasets/:id/items` with no `limit` streams the entire dataset (Apify parity); also fixes the dashboard's truncated dataset download
- Community feedback funnels (issue templates, deployment report, CLI one-time post-push note); npm publish pipeline fixed (Node `^24.15.0` floor)

---

## Non-Goals

To keep focus, these are explicitly **not** on the roadmap:

- ❌ Web IDE for editing Actors
- ❌ Multi-tenant workspaces
- ❌ Complex RBAC/permissions
- ❌ Built-in rotation of custom proxy URLs (bring your own; Apify proxy passthrough — runner proxy-resolver with three-tier resolution and AES-256-GCM at rest — shipped in v0.9.4)

---

## Contributing

Have ideas? [Open an issue on GitHub](https://github.com/crawlee-cloud/crawlee-cloud/issues)!

The best contributions are CLI improvements, bug fixes, and documentation.
