# Crawlee Cloud Roadmap

A CLI-first platform for running large-scale scrapers on your own infrastructure.

## Current Version: v1.6.0 ✅

- Apify-compatible REST API
- Docker-based Actor execution with auto-scaling runners
- CLI for deployment (`crc push`, `crc run`, `crc logs`)
- Datasets, Key-Value Stores, Request Queues
- Web dashboard with run cost analysis

> Detailed per-version history lives in [docs/roadmap.md](docs/roadmap.md) and [CHANGELOG.md](CHANGELOG.md).

### Shipped since v0.5.0 (highlights)

- **v0.6.0 – v0.7.0** — DigitalOcean deployment, runner auto-scaler + heartbeat, image registry support, periodic Docker cleanup
- **v0.8.x** — build versioning, CLI profiles, dashboard rewrite, production-hardening patch cycle
- **v0.9.x** — retention reaper, pagination at scale, Apify webhook templating, Apify proxy passthrough, multi-replica safety
- **v1.0.0** — semver stability commitment on the Apify v2 API, `crc` CLI commands, and documented env vars
- **v1.1.x – v1.2.x** — zombie-run reaper, OOM visibility, memory-aware placement, auth hot-path and runner-key fixes
- **v1.3.0 – v1.5.0** — run cost analysis (per run and in the runs list), safe actor force-deletion, webhook SSRF loopback fixes, CI coverage floors
- **v1.6.0** — runner disk-pressure protection (claim gate + registry-scoped image eviction + infra retry floor), full-dataset streaming on no-limit reads (Apify parity)

---

## Proposed — RFC open

Not committed to a version yet — each has an open discussion gathering input before implementation is scoped:

- **Official Python actor support** — Python actors already run today (the runner is Docker-image-based, and `crc init`/`crc dev` handle Python templates); this makes it official with docs, curated templates, and SDK-compat verification. [Join the RFC →](https://github.com/orgs/crawlee-cloud/discussions/95)
- **Platform MCP server** — let AI agents (Claude, Cursor, …) run actors, check runs, and fetch datasets on your instance via the Model Context Protocol. TypeScript, against the platform as it is today. [Join the RFC →](https://github.com/orgs/crawlee-cloud/discussions/96)

---

## v0.2.0 - CLI & Developer Experience

Priority: Make the CLI the best way to work with Crawlee Cloud.

- [x] **Improved CLI output** - Better formatting, colors, progress bars
- [x] **`crc init`** - Scaffold new Actor projects from templates
- [x] **`crc dev`** - Local development mode with hot reload
- [x] **`crc status`** - Check run status and resource usage
- [x] **Input schema validation** - Validate inputs before running
- [x] **Better error messages** - Actionable hints for common issues

## v0.3.0 - Production Scraping at Scale ✅

Priority: Run large scraping jobs reliably.

- [x] **Cron scheduling** - Schedule runs with cron expressions
- [x] **Retry policies** - Automatic retries with configurable backoff
- [x] **Run timeouts** - Kill stuck runs automatically
- [x] **Webhooks** - HTTP callbacks on run completion with delivery tracking and exponential backoff retry
- [x] **Multi-worker runners** - Scale horizontally for parallel execution
- [x] **Resource limits** - Memory/CPU caps per run

## v0.4.0 - Reliability & Operations ✅

Priority: Production-grade stability.

- [x] **Metrics & monitoring** - Prometheus endpoints (`GET /metrics` with prom-client, admin-only)
- [x] **Health checks** - Liveness (`/health/live`) and readiness (`/health/ready`) probes with DB, Redis, S3 checks
- [x] **Graceful shutdown** - API server drains requests, runner waits for active containers (configurable timeout)
- [x] **Run history retention** - CLI cleanup script with `--dry-run`, S3 + DB cleanup
- [x] **Backup & restore** - `pg_dump`/`pg_restore` wrapper scripts

## v0.5.0 - Security & Polish ✅

Priority: Secure the platform and prepare for wider use.

- [x] **One-click cloud deploy** - Deploy buttons for Railway, Render, DigitalOcean + VPS script with Caddy auto-HTTPS
- [x] **Authentication middleware** - All API routes require authentication via preHandler hook
- [x] **User-scoped resources** - Datasets, KV stores, request queues, and actors are scoped per user
- [x] **Input validation** - Zod schemas for all route inputs (datasets, KV stores, request queues, runs)
- [x] **SSRF protection** - Block webhook delivery to private/internal network addresses (RFC 1918, loopback, link-local)
- [x] **Runner API key from Redis** - Runner fetches API key from Redis instead of static config
- [x] **Security config validation** - Startup checks for weak secrets, insecure DB/S3 credentials, CORS
- [x] Actor versioning - Deploy and rollback specific versions (shipped in v0.8.0: registry routes, `actor_versions`/`actor_builds` tables, dashboard Builds page)
- [ ] API key scopes - Read-only vs full access keys
- [x] Improved dashboard - Better UX for those who prefer UI (shipped in v0.8.0 dashboard rewrite)
- [x] Documentation improvements (docs moved into `docs/` as source of truth in v0.8.0)

---

## Non-Goals (for now)

To keep focus, these are explicitly **not** on the roadmap:

- ❌ Web IDE for editing Actors
- ❌ Multi-tenant workspaces
- ❌ Complex RBAC/permissions
- ❌ Built-in rotation of custom proxy URLs (bring your own; Apify proxy passthrough shipped in v0.9.4)

---

## Contributing

Have ideas? Open an issue on GitHub!

The best contributions are CLI improvements, bug fixes, and documentation.
