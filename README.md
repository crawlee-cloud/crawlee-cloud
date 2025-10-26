# Crawlee Platform

**Self-hosted Apify-compatible platform for Crawlee scrapers.**

Reduce costs by running scrapers on your own infrastructure.

## How It Works

```bash
APIFY_API_BASE_URL=https://your-server.com/v2
APIFY_TOKEN=your-token
```

## Quick Start

```bash
npm run docker:dev
npm install && npm run build
npm run db:migrate
npm run dev
```

## Architecture

```
┌─────────────────────────────────────────┐
│           YOUR ACTOR CODE               │
│  import { Actor } from 'apify';         │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│        CRAWLEE PLATFORM API             │
└─────────────────────────────────────────┘
       │           │           │
       ▼           ▼           ▼
  PostgreSQL    Redis      S3/MinIO
```

## Progress

- [x] Docker infrastructure
- [x] API server
- [x] Actor runner
- [ ] Dashboard
- [ ] CLI

## License

MIT
