# Crawlee Cloud Roadmap

A CLI-first platform for running large-scale scrapers on your own infrastructure.

## Current Version: v0.1.0 ✅

- Apify-compatible REST API
- Docker-based Actor execution
- CLI for deployment (`cc push`, `cc run`, `cc logs`)
- Datasets, Key-Value Stores, Request Queues
- Basic web dashboard

---

## v0.2.0 - CLI & Developer Experience

Priority: Make the CLI the best way to work with Crawlee Cloud.

- [ ] **Improved CLI output** - Better formatting, colors, progress bars
- [ ] **`cc init`** - Scaffold new Actor projects from templates
- [ ] **`cc dev`** - Local development mode with hot reload
- [ ] **`cc status`** - Check run status and resource usage
- [ ] **Input schema validation** - Validate inputs before running
- [ ] **Better error messages** - Actionable hints for common issues

## v0.3.0 - Production Scraping at Scale

Priority: Run large scraping jobs reliably.

- [ ] **Cron scheduling** - Schedule runs with cron expressions
- [ ] **Retry policies** - Automatic retries with configurable backoff
- [ ] **Run timeouts** - Kill stuck runs automatically
- [ ] **Webhooks** - HTTP callbacks on run completion
- [ ] **Multi-worker runners** - Scale horizontally for parallel execution
- [ ] **Resource limits** - Memory/CPU caps per run

## v0.4.0 - Reliability & Operations

Priority: Production-grade stability.

- [ ] **Metrics & monitoring** - Prometheus endpoints
- [ ] **Health checks** - API and runner health monitoring
- [ ] **Graceful shutdown** - Complete in-flight runs before stopping
- [ ] **Run history retention** - Auto-cleanup old runs and data
- [ ] **Backup & restore** - Database backup utilities

## v0.5.0 - Polish

- [ ] **Actor versioning** - Deploy and rollback specific versions
- [ ] **API key scopes** - Read-only vs full access keys
- [ ] **Improved dashboard** - Better UX for those who prefer UI
- [ ] **Documentation improvements**

---

## Non-Goals (for now)

To keep focus, these are explicitly **not** on the roadmap:

- ❌ Web IDE for editing Actors
- ❌ Multi-tenant workspaces
- ❌ Complex RBAC/permissions
- ❌ Built-in proxy rotation (use your own)

---

## Contributing

Have ideas? Open an issue on GitHub!

The best contributions are CLI improvements, bug fixes, and documentation.
