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

[Documentation](https://crawlee.cloud/docs) · [Quick Start](#quick-start) · [Contributing](#contributing)

</div>

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

| Method                                                                                                                                                                               | Description                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/crawlee-cloud/crawlee-cloud&referralCode=crawlee)                | One-click deploy with managed databases      |
| [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/crawlee-cloud/crawlee-cloud)                          | Free tier available                          |
| [![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/crawlee-cloud/crawlee-cloud/tree/main&refcode=crawlee) | DigitalOcean App Platform                    |
| [VPS Deploy Script](deploy/)                                                                                                                                                         | Full stack on any Ubuntu VPS with auto-HTTPS |

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
