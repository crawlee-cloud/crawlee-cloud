<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./logo-light.svg">
    <img src="./logo-dark.svg" width="450" alt="Crawlee Cloud Logo" />
  </picture>

**Self-hosted, open-source platform for running Apify Actors on your own infrastructure.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org/)

<a href="https://www.producthunt.com/products/crawlee-cloud?utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-crawlee-cloud" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1054817&theme=light" alt="Crawlee Cloud - Self-hosted platform for running web scrapers | Product Hunt" width="250" height="54" /></a>

[Dashboard](#dashboard) · [Quick Start](#quick-start) · [Documentation](#documentation) · [Contributing](#contributing)

</div>

---

## Dashboard

A purpose-built operator console — monitor runs in real time, debug webhook deliveries, browse datasets, and triage failures without leaving the page.

<p align="center">
  <img src="./docs/screenshots/02-dashboard-home.png" width="900" alt="Operator dashboard — KPIs, throughput, recent activity" />
  <br/>
  <em>Operator dashboard — actor count, runs, success rate, hourly throughput, recent activity feed</em>
</p>

<table>
<tr>
<td width="50%">
<img src="./docs/screenshots/05-webhooks.png" width="100%" alt="Webhooks — test fire, deliveries drawer, last-seen indicator" />
<p align="center"><em>Webhooks — fire test events per subscription, inline delivery log with HTTP code + body, last-seen status</em></p>
</td>
<td width="50%">
<img src="./docs/screenshots/06-run-detail.png" width="100%" alt="Run detail — logs, runtime, storage IDs" />
<p align="center"><em>Run detail — live logs, container runtime, dataset / KV / queue IDs, status timeline</em></p>
</td>
</tr>
<tr>
<td width="50%">
<img src="./docs/screenshots/04-settings.png" width="100%" alt="Settings — version, scaler state, storage health" />
<p align="center"><em>Settings — live version, scaler state, storage health probes (PG / Redis / S3) with latency, API keys</em></p>
</td>
<td width="50%">
<img src="./docs/screenshots/08-kv-inline-preview.png" width="100%" alt="KV store inline preview" />
<p align="center"><em>KV stores — click any record to pretty-print its JSON inline, no new tab needed</em></p>
</td>
</tr>
<tr>
<td width="50%">
<img src="./docs/screenshots/03-runs.png" width="100%" alt="Runs — execution history" />
<p align="center"><em>Runs — full execution history with status filters, durations, dataset links</em></p>
</td>
<td width="50%">
<img src="./docs/screenshots/07-actors.png" width="100%" alt="Actors — deploy and manage" />
<p align="center"><em>Actors — your deployed scrapers with version + last-modified at a glance</em></p>
</td>
</tr>
</table>

---

## Why Crawlee Cloud?

Love the Crawlee/Apify ecosystem but want the freedom to run things your way? Crawlee Cloud brings the same great developer experience to your own infrastructure. Keep using the tools you love — just host them wherever you want.

### Key Benefits

- **� Your infrastructure** — Deploy on your own servers, cloud, or anywhere you like
- **🔒 Complete privacy** — Your data stays exactly where you want it
- **⚡ SDK compatible** — Works seamlessly with the Apify SDK you already know
- **🐳 Container-based** — Each Actor runs in an isolated Docker container
- **📊 Beautiful dashboard** — Monitor runs, explore datasets, manage everything visually

---

## How It Works

```bash
# Instead of pointing to Apify's servers...
export APIFY_API_BASE_URL=https://api.apify.com/v2

# Point to your own Crawlee Cloud instance
export APIFY_API_BASE_URL=https://your-server.com/v2
export APIFY_TOKEN=your-token
```

Your existing Actor code works without any modifications:

```typescript
import { Actor } from 'apify';

await Actor.init();
await Actor.pushData({ title: 'Scraped data' });
await Actor.exit();
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- PostgreSQL, Redis, and S3-compatible storage (or use our Docker setup)

### 1. Clone & Install

```bash
git clone https://github.com/crawlee-cloud/crawlee-cloud.git
cd crawlee-cloud
npm install
```

### 2. Start Infrastructure

```bash
# Starts PostgreSQL, Redis, and MinIO
npm run docker:dev
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings
```

### 4. Build & Run

```bash
npm run build
npm run db:migrate
npm run dev
```

The API server starts at `http://localhost:3000`.

---

## Deploy

Deploy your own instance in minutes:

| Method                                                                                                                                                                               | Status         | Description                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ---------------------------------------------------------------------- |
| [![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/crawlee-cloud/crawlee-cloud/tree/main&refcode=crawlee) | ✅ Supported   | Automated full stack — App Platform, managed PG/Redis, Runner Droplet  |
| [VPS Deploy Script](deploy/vps/)                                                                                                                                                     | ✅ Supported   | Full stack on any Ubuntu VPS with auto-HTTPS via Caddy                 |
| Railway                                                                                                                                                                              | 🚧 Coming soon | One-click PaaS deploy (template scaffolding present, not yet verified) |
| Render                                                                                                                                                                               | 🚧 Coming soon | One-click PaaS deploy (blueprint present, not yet verified)            |

See [deploy/](deploy/) for detailed instructions.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your Actors                              │
│            (using official Apify SDK, no changes)               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Crawlee Cloud API                           │
│              (Apify-compatible REST endpoints)                  │
└─────────────────────────────────────────────────────────────────┘
        │                    │                    │
        ▼                    ▼                    ▼
   ┌──────────┐         ┌─────────┐         ┌─────────┐
   │PostgreSQL│         │  Redis  │         │ S3/MinIO│
   │ metadata │         │ queues  │         │  blobs  │
   └──────────┘         └─────────┘         └─────────┘
```

### Components

| Component      | Description                                                 |
| -------------- | ----------------------------------------------------------- |
| **API Server** | Fastify-based REST API compatible with Apify's v2 endpoints |
| **Runner**     | Polls job queue and executes Actors in Docker containers    |
| **Dashboard**  | Next.js web UI for monitoring and management                |
| **CLI**        | Command-line tool for pushing and running Actors            |

---

## Documentation

| Guide                                                                 | Description                  |
| --------------------------------------------------------------------- | ---------------------------- |
| [API Reference](https://crawlee.cloud/docs/api)                       | REST API endpoints and usage |
| [CLI Guide](https://crawlee.cloud/docs/cli)                           | Command-line interface       |
| [Dashboard](https://crawlee.cloud/docs/dashboard)                     | Web interface overview       |
| [Deployment](https://crawlee.cloud/docs/deployment)                   | Production deployment guide  |
| [Runner](https://crawlee.cloud/docs/runner)                           | Actor execution engine       |
| [SDK Compatibility](https://crawlee.cloud/docs/apify-sdk-environment) | Apify SDK integration        |

---

## Supported Apify SDK Features

| Feature                                      | Status       |
| -------------------------------------------- | ------------ |
| Datasets (`Actor.pushData`)                  | ✅ Supported |
| Key-Value Stores (`Actor.getValue/setValue`) | ✅ Supported |
| Request Queues                               | ✅ Supported |
| Request deduplication                        | ✅ Supported |
| Distributed locking                          | ✅ Supported |
| Builds & versioning                          | ✅ Supported |
| Webhooks                                     | ✅ Supported |
| Schedules                                    | ✅ Supported |
| Auto-scaling runners (local Docker, GHCR)    | ✅ Supported |

---

## What's New

**v0.8.0** — auto-scaling with image registry support, build versioning, scale-aware run pagination, CLI profiles + `crc info`, dashboard rewrite (Builds, Schedules, Webhooks, Request Queues, Runners, KV browser). See the [full changelog](CHANGELOG.md).

> ⚠️ **Upgrading from v0.7?** `GET /metrics` and `GET /v2/scaler/status` are now admin-only. If you scrape `/metrics` with Prometheus, send an admin token in the `Authorization` header, or set `METRICS_PUBLIC=true`. See [CHANGELOG → 0.8.0 Breaking](CHANGELOG.md#080---2026-05-01).

---

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

```bash
# Run tests
npm test

# Type checking
npm run typecheck

# Linting
npm run lint
```

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">

**Built with ❤️ for the web scraping community**

</div>
