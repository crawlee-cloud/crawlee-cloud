# Dashboard

The Crawlee Cloud Dashboard provides a web interface for managing Actors and monitoring runs.

## Accessing the Dashboard

```
http://localhost:3001
```

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

### Datasets

- List datasets with item counts
- View and search items
- Export as JSON

### Settings

- API token management
- Server configuration
- User preferences

## Theme

Supports light and dark modes via the header toggle.

## Authentication

Login with your API token or register a new account.
