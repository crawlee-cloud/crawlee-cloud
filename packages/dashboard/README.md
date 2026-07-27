# Crawlee Cloud Dashboard

Next.js web UI for monitoring and managing your self-hosted [Crawlee Cloud](https://crawlee.cloud) instance.

## What's inside

- **Actors** — list, create, edit, and inspect actor versions and builds
- **Runs** — start runs, watch live logs over WebSocket, browse outputs
- **Datasets** — paginated browser with JSON/CSV export
- **Key-Value Stores** — inspect and edit values inline
- **Request Queues** — list pending and handled requests with locking state
- **Builds** — track build history and active version per actor
- **Schedules** — cron-style scheduled runs
- **Webhooks** — configure event-driven notifications
- **Runners** — view connected runners, capacity, and recent assignments
- **Retention** — reaper status for expired datasets, stores, queues, and runs
- **Docs** — in-app documentation hub linking to guides and API references
- **Settings** — API tokens, users, and instance configuration

Built with Next.js 16 App Router, React 19, Tailwind v4, and Radix UI primitives.

## Development

From the repo root:

```bash
npm install
npm run dev --workspace=@crawlee-cloud/dashboard
```

`npm run dev` starts plain `next dev`, so the dashboard runs at [http://localhost:3000](http://localhost:3000) locally (port 3001 applies only in the Docker Compose stack, via `PORT=3001`). It talks to the API server at `NEXT_PUBLIC_API_URL` (defaults to `http://localhost:3000`).

## Configuration

| Variable              | Description                              |
| --------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_API_URL` | Base URL of the Crawlee Cloud API server |

Authentication is a simple token cookie checked in the Next.js middleware — there is no NextAuth dependency and no extra auth configuration.

## Deployment

The dashboard ships as part of the full stack — see [`deploy/`](../../deploy/) at the repo root for DigitalOcean and VPS deployment guides.
