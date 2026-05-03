# Roadmap

A CLI-first platform for running large-scale scrapers on your own infrastructure.

## Current Version: v0.9.1

- Apify-compatible webhook payload templating engine (quoted, unquoted, interpolated, dot notation)
- Server-side `?q=` substring search on every list endpoint
- Reaper uses `GREATEST(accessed_at, modified_at)` so actively-written-to unnamed resources don't get reaped
- Dashboard counter tiles read real `COUNT(*)` instead of capped `items.length`
- Stress-fixture script in tree for at-scale QA

The platform survives months of operation unattended (retention reaper from v0.9.0), runs on real production volume (race-free dataset push from v0.8.0+, real pagination from v0.9.0), and is now Apify-template-compatible end-to-end.

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

## v0.9.x patch line

Anything additive or bug-fix-shaped lands here as `0.9.<n+1>` until v1.0 cuts.

---

## v1.0.0 — Stability commitment

**The next major after v0.9.x is `1.0.0`, not `0.10.0`.** Going to 1.0 carries semver weight: breaking changes after 1.0 cost a major bump or a deprecation window, so the version is also a commitment to the contract.

What goes in:

| Area                                                    | Why it's a v1.0 task                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` workspace                             | The `applyWebhookTemplate` engine is duplicated in api+runner with KEEP-IN-SYNC headers. Promote to a real workspace. |
| Apify v2 API drift audit                                | Any gap between our v2 surface and current Apify is cheaper to close before the contract is "supported."              |
| DB migration policy                                     | Forward-only, additive. No breaking column drops without a deprecation window. Documented.                            |
| CLI command stability                                   | No rename/repurpose without a `crawlee-cloud migrate` style helper.                                                   |
| Webhook `payload_template` examples in dashboard editor | So operators don't have to consult Apify docs to discover `{{eventData}}` syntax.                                     |
| Auth/role surface tightening                            | Admin scopes, API key TTLs — anything role-related lands here so post-1.0 doesn't break tokens.                       |

---

## Non-Goals

To keep focus, these are explicitly **not** on the roadmap:

- ❌ Web IDE for editing Actors
- ❌ Multi-tenant workspaces
- ❌ Complex RBAC/permissions
- ❌ Built-in proxy rotation (use your own)

---

## Contributing

Have ideas? [Open an issue on GitHub](https://github.com/crawlee-cloud/crawlee-cloud/issues)!

The best contributions are CLI improvements, bug fixes, and documentation.
