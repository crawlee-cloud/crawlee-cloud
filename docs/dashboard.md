# Dashboard

The Crawlee Cloud Dashboard provides a web interface for managing Actors and monitoring runs.

## Accessing the Dashboard

```
http://localhost:3001
```

In the Docker Compose stack the dashboard listens on port 3001 (set via `PORT=3001` in `docker-compose.yml`). When run locally with `npm run dev` it uses Next.js's default port 3000.

## Features

### Home

- Recent Actor runs with status
- Quick stats (Actors, runs, datasets)
- System health indicators

### Actors

- View all registered Actors
- Actor details and version history
- Start runs with custom input
- View associated runs and datasets

### Runs

- Real-time status updates
- Live log streaming via WebSocket
- View output and errors
- Abort running Actors
- **Cost column** (since 1.4.0): per-run cost at a glance — `$0` for self-hosted runs, a dollar figure for droplet-attributed runs, `—` while running or when attribution was never recorded
- **Cost Analysis card** on run details (since 1.3.0): items scraped, your cost, what the same run would cost on Apify, and savings % — shown once a run reaches a terminal status

### Builds

- Recent build activity across all Actors (50 most recent, newest first)
- Succeeded / failed / in-flight counts at a glance
- Full per-Actor build history lives on the Actor's detail page

### Datasets

- List datasets with item counts
- View and search items
- Export as JSON

### Key-Value Stores

- List stores with search and pagination
- Inspect keys and values (per-run scratch space for INPUT, OUTPUT, and Actor state)
- Delete stores (removes all keys and values from S3)

### Request Queues

- List queues with pending vs handled request counts
- Inspect individual requests and their locking state
- Delete queues

### Schedules

- Cron-based scheduled runs with common presets (hourly, daily, weekdays, custom)
- Enable / pause schedules without deleting them
- Deleting a schedule removes the cron job; existing runs are unaffected

### Webhooks

- Create and edit webhooks, scoped either platform-wide (catalog) or per-run
- Send test deliveries and browse per-webhook delivery history
- Custom payload templates behave identically in test and production delivery

### Runners

- Live runner list with status, capacity, and heartbeats (auto-refreshing)
- Backed by the scaler status endpoint — requires an admin user

### Retention

- Retention reaper status: what expired datasets, KV stores, queues, and runs were reaped in the last 24 hours
- Requires an admin user

### Docs

- In-app documentation hub linking to getting started, API reference, CLI guide, Crawlee framework docs, self-hosting, and Apify compatibility

### Settings

- API token management
- Server configuration
- User preferences

## Theme

Supports light and dark modes via the header toggle.

## Authentication

Login with your API token. The token is stored as a cookie, and unauthenticated requests are redirected to the login page.
