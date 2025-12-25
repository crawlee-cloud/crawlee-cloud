<div align="center">

# Crawlee Cloud

**Self-hosted, open-source platform for running Apify Actors on your own infrastructure.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org/)

[Documentation](./docs) · [Quick Start](#quick-start) · [Contributing](#contributing)

</div>

---

## Why Crawlee Cloud?

Running web scrapers at scale can get expensive. Crawlee Cloud lets you run your existing Apify Actors on your own servers with **zero code changes** — just point your SDK to your server instead of Apify's.

### Key Benefits

- **💰 Reduce costs** — No per-compute-unit pricing, just your infrastructure costs
- **🔒 Data privacy** — Your scraped data never leaves your servers
- **⚡ Full compatibility** — Works with the official Apify SDK out of the box
- **🐳 Container-based** — Each Actor runs in an isolated Docker container
- **📊 Built-in dashboard** — Monitor runs, browse datasets, manage Actors

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

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your Actors                               │
│            (using official Apify SDK, no changes)                │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Crawlee Cloud API                            │
│              (Apify-compatible REST endpoints)                   │
└─────────────────────────────────────────────────────────────────┘
        │                    │                    │
        ▼                    ▼                    ▼
   ┌─────────┐         ┌─────────┐         ┌─────────┐
   │PostgreSQL│         │  Redis  │         │ S3/MinIO│
   │ metadata │         │ queues  │         │  blobs  │
   └─────────┘         └─────────┘         └─────────┘
```

### Components

| Component | Description |
|-----------|-------------|
| **API Server** | Fastify-based REST API compatible with Apify's v2 endpoints |
| **Runner** | Polls job queue and executes Actors in Docker containers |
| **Dashboard** | Next.js web UI for monitoring and management |
| **CLI** | Command-line tool for pushing and running Actors |

---

## Documentation

| Guide | Description |
|-------|-------------|
| [API Reference](./docs/api.md) | REST API endpoints and usage |
| [CLI Guide](./docs/cli.md) | Command-line interface |
| [Dashboard](./docs/dashboard.md) | Web interface overview |
| [Deployment](./docs/deployment.md) | Production deployment guide |
| [Runner](./docs/runner.md) | Actor execution engine |
| [SDK Compatibility](./docs/apify-sdk-environment.md) | Apify SDK integration |

---

## Supported Apify SDK Features

| Feature | Status |
|---------|--------|
| Datasets (`Actor.pushData`) | ✅ Supported |
| Key-Value Stores (`Actor.getValue/setValue`) | ✅ Supported |
| Request Queues | ✅ Supported |
| Request deduplication | ✅ Supported |
| Distributed locking | ✅ Supported |

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
