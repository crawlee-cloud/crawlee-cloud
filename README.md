# Crawlee Platform

**Self-hosted Apify-compatible platform for Crawlee scrapers.**

## How It Works

```bash
APIFY_API_BASE_URL=https://your-server.com/v2
APIFY_TOKEN=your-token
```

Zero code changes required in your Actors!

## Quick Start

```bash
npm run docker:dev
npm install && npm run build
npm run db:migrate
npm run dev
```

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /v2/datasets/{id}/items` | Push data |
| `GET /v2/datasets/{id}/items` | Get data |
| `PUT /v2/key-value-stores/{id}/records/{key}` | Store values |
| `POST /v2/request-queues/{id}/requests` | Add URLs |
| `POST /v2/acts/{id}/runs` | Start Actor |

## Progress

- [x] Docker infrastructure
- [x] API server with endpoints
- [ ] Actor runner
- [ ] Dashboard
- [ ] CLI

## License

MIT
