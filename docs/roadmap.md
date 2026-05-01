# Roadmap

A CLI-first platform for running large-scale scrapers on your own infrastructure.

## Current Version: v0.6.x

- Everything from v0.5.0 plus:
- DigitalOcean App Platform deployment (API + Dashboard)
- Single-command DO setup script (PG, Redis, App Platform, Runner Droplet)
- One-click deploy templates for Railway, Render, DigitalOcean
- Platform-agnostic runner auto-scaler (DO provider, extensible)
- Runner heartbeat system (CPU, memory, disk metrics via Redis)
- Dashboard path-routing for reverse proxy deployments
- Scraper deployment tooling (deploy any scraper from a monorepo)

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

## v0.3.0 ✅ - Production Scraping at Scale

| Feature         | Status                                            |
| --------------- | ------------------------------------------------- |
| Cron scheduling | ✅ Shipped — schedules table + scheduler service  |
| Retry policies  | ✅ Shipped — configurable max retries and backoff |
| Run timeouts    | ✅ Shipped — container timeout enforcement        |
| Webhooks        | ✅ Shipped — webhook deliveries with retry logic  |
| Resource limits | ✅ Shipped — memory limits per container          |

## v0.4.0 ✅ - Reliability & Operations

| Feature           | Status                                                          |
| ----------------- | --------------------------------------------------------------- |
| Metrics           | ✅ Shipped — Prometheus /metrics endpoint                       |
| Health checks     | ✅ Shipped — /health endpoint                                   |
| Graceful shutdown | ✅ Shipped — SIGTERM/SIGINT handlers in API and runner          |
| Backup & restore  | ✅ Shipped — backup:create, backup:restore, backup:list scripts |

## v0.5.0 ✅ - Security & Polish

| Feature                    | Status                                              |
| -------------------------- | --------------------------------------------------- |
| Auth middleware            | ✅ Shipped — JWT + API key authentication           |
| User-scoped resources      | ✅ Shipped — IDOR protection                        |
| Input validation           | ✅ Shipped — Zod schemas on all endpoints           |
| SSRF protection            | ✅ Shipped — webhook URL validation                 |
| Security config validation | ✅ Shipped — blocks insecure defaults in production |

## v0.6.0 ✅ - Cloud Deployment & Auto-Scaling

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

## v0.7.0 - Scale & Operate

**Priority:** Production operations for 100+ scrapers.

| Feature                 | Description                                                         |
| ----------------------- | ------------------------------------------------------------------- |
| GHCR image registry     | Push actor images to GitHub Container Registry for fast runner pull |
| DO Spaces integration   | Managed S3 storage instead of self-hosted MinIO                     |
| Scheduling UI           | Create and manage cron schedules from the dashboard                 |
| Actor versioning        | Complete the versioning workflow (table exists, needs UI)           |
| API key scopes          | Read-only vs full access keys                                       |
| Hetzner scaler provider | Scale runners on Hetzner Cloud (cheaper than DO)                    |

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
