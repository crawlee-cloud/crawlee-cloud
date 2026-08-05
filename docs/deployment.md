# Deployment Guide

Deploy Crawlee Cloud to your own infrastructure.

## Requirements

- **Node.js** 20+
- **Docker** & Docker Compose
- **PostgreSQL** 14+
- **Redis** 6+
- **S3-compatible storage** (MinIO, AWS S3, etc.)

---

## Quick Start (Development)

The fastest way to get the full stack running:

```bash
# Clone repository
git clone https://github.com/crawlee-cloud/crawlee-cloud.git
cd crawlee-cloud

# Start everything
docker compose up -d

# Run database migrations (they do not run automatically on startup)
docker compose exec api node packages/api/dist/db/migrate.js
```

> **Important:** The stock `docker-compose.yml` does **not** read a `.env` file — it hard-codes dev admin credentials (`ADMIN_EMAIL=admin@crawlee.cloud`, `ADMIN_PASSWORD=crawlee.cloud`), so that is the login for this flow. Setting `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env` applies to the non-Docker flow below and to `deploy/vps/docker-compose.prod.yml` (which does substitute `${ADMIN_EMAIL}`). Note that `.env.example` does not include `ADMIN_EMAIL`, `ADMIN_PASSWORD`, or `CORS_ORIGINS` — add these keys yourself where needed.

> **Note:** The stock compose file sets `DOCKER_NETWORK=crawlee-platfrom_crawlee-network` for the Runner, which only matches if the checkout directory is named `crawlee-platfrom`. If you cloned into a differently named directory, adjust that value to `<your-directory>_crawlee-network`.

This brings up the full stack — API, Runner, Dashboard, Scheduler, PostgreSQL, Redis, and MinIO (plus a one-shot `minio-init` job that creates the storage bucket and exits). Once running:

- **Dashboard:** `http://localhost:3001` — monitor runs, view datasets, manage Actors
- **API:** `http://localhost:3000`

---

## Building from Source (Non-Docker Development)

If you want to run the API outside Docker (e.g., for debugging or local development), use the infrastructure-only Compose file:

```bash
# Start infrastructure only (PostgreSQL, Redis, MinIO)
docker compose -f docker-compose.dev.yml up -d

# Install dependencies and build
npm install
npm run build

# Run database migrations (required before first start)
npm run db:migrate

# Start the API server in dev mode
npm run dev
```

> **Note:** This flow only starts the API server. The Runner and Dashboard will not be running, so pushed Actors will not execute. Use the full `docker compose up -d` flow above if you need the complete stack.

---

## Production Deployment

### Using Docker Compose

```bash
docker compose up -d
```

This starts:

- API Server (port 3000)
- Runner
- Dashboard (port 3001)
- Scheduler
- PostgreSQL
- Redis
- MinIO (plus a one-shot `minio-init` job that creates the storage bucket and exits)

Database migrations do **not** run automatically on startup — run them once after the containers are up:

```bash
docker compose exec api node packages/api/dist/db/migrate.js
```

If you are running from source outside Docker, run `npm run db:migrate` instead before starting the server.

The **Dashboard** at `http://localhost:3001` provides a web UI for monitoring Actor runs, viewing datasets and key-value stores, and managing Actors.

### Environment Variables

Create a `.env` file with your production settings:

| Variable              | Description                        | Required                |
| --------------------- | ---------------------------------- | ----------------------- |
| `NODE_ENV`            | Set to `production` for production | Yes                     |
| `PORT`                | API server port                    | No (default: 3000)      |
| `DATABASE_URL`        | PostgreSQL connection string       | Yes                     |
| `REDIS_URL`           | Redis connection string            | Yes                     |
| `S3_ENDPOINT`         | S3-compatible endpoint URL         | Yes                     |
| `S3_ACCESS_KEY`       | S3 access key                      | Yes                     |
| `S3_SECRET_KEY`       | S3 secret key                      | Yes                     |
| `S3_BUCKET`           | S3 bucket name                     | Yes                     |
| `S3_REGION`           | S3 region                          | No (default: us-east-1) |
| `S3_FORCE_PATH_STYLE` | Use path-style S3 URLs (for MinIO) | No (default: true)      |
| `API_SECRET`          | JWT signing secret (min 32 chars)  | Yes                     |
| `CORS_ORIGINS`        | Comma-separated allowed origins    | Yes                     |
| `ADMIN_EMAIL`         | Initial admin user email           | Yes (for first setup)   |
| `ADMIN_PASSWORD`      | Initial admin user password        | Yes (for first setup)   |
| `LOG_LEVEL`           | Log verbosity                      | No (default: info)      |

> **Note:** `ADMIN_EMAIL` and `ADMIN_PASSWORD` are required for the initial setup. Without them, no admin user is created and you will not be able to authenticate.

### Example `.env`

```bash
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://user:pass@db:5432/crawlee
REDIS_URL=redis://redis:6379
S3_ENDPOINT=https://s3.amazonaws.com
S3_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
S3_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_BUCKET=crawlee-cloud-storage
API_SECRET=your-secure-random-string-at-least-32-characters
CORS_ORIGINS=https://your-domain.com
ADMIN_EMAIL=admin@your-domain.com
ADMIN_PASSWORD=your-secure-admin-password
```

### Security Validation

On startup, the API server validates configuration and will:

- **In production**: Refuse to start if insecure defaults are detected (weak secrets, default DB passwords, default S3 credentials, missing CORS config)
- **In development**: Log warnings but continue

You can also validate your config before deploying:

```bash
npm run security:validate-config
```

---

## Scaling

| Component  | Scaling Strategy                    |
| ---------- | ----------------------------------- |
| API Server | Horizontal (stateless)              |
| Runner     | Horizontal (multiple instances)     |
| PostgreSQL | Managed service recommended         |
| Redis      | Redis Cluster for high availability |
| S3         | Managed service recommended         |

---

## Health Checks

```bash
curl http://localhost:3000/health
```

Returns:

```json
{ "status": "ok", "version": "1.6.0" }
```

The `version` field reflects the release you have installed.

---

## Backups

- **PostgreSQL**: Use `pg_dump` or managed backups
- **S3**: Enable bucket versioning
- **Redis**: Enable RDB/AOF persistence

---

## Troubleshooting

### Runner fails with "column run_after does not exist"

The database schema is out of date. Run migrations:

```bash
npm run db:migrate
```

If you are using Docker Compose, run the migrations inside the API container:

```bash
docker compose exec api node packages/api/dist/db/migrate.js
```

### Actor runs fail with "401 Invalid token"

The Runner needs a valid API key to communicate with the API server. Ensure the API server started successfully and created the runner API key. Check the API logs for the message `Runner API key created`:

```bash
docker compose logs api
```

If the message is missing, the API may have failed during startup. Check for other errors in the logs.

### API crashes with "Cannot find module"

The project needs to be rebuilt. This commonly happens after pulling new changes:

```bash
npm run build
```

Then restart the server.
