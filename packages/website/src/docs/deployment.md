# Deployment Guide

Deploy Crawlee Cloud to your own infrastructure.

## Requirements

- **Node.js** 18+
- **Docker** & Docker Compose
- **PostgreSQL** 14+
- **Redis** 6+
- **S3-compatible storage** (MinIO, AWS S3, etc.)

---

## Quick Start (Development)

```bash
# Clone repository
git clone https://github.com/crawlee-cloud/crawlee-cloud.git
cd crawlee-cloud

# Start infrastructure
docker compose -f docker-compose.dev.yml up -d

# Install and build
npm install
npm run build

# Run migrations
npm run db:migrate

# Start server
npm run dev
```

---

## Production Deployment

### Using Docker Compose

```bash
docker compose up -d
```

This starts:

- API Server (port 3000)
- Runner
- PostgreSQL
- Redis
- MinIO

### Environment Variables

Create a `.env` file with your production settings:

| Variable        | Description                  | Required                |
| --------------- | ---------------------------- | ----------------------- |
| `PORT`          | API server port              | No (default: 3000)      |
| `DATABASE_URL`  | PostgreSQL connection string | Yes                     |
| `REDIS_URL`     | Redis connection string      | Yes                     |
| `S3_ENDPOINT`   | S3-compatible endpoint URL   | Yes                     |
| `S3_ACCESS_KEY` | S3 access key                | Yes                     |
| `S3_SECRET_KEY` | S3 secret key                | Yes                     |
| `S3_BUCKET`     | S3 bucket name               | Yes                     |
| `S3_REGION`     | S3 region                    | No (default: us-east-1) |
| `API_SECRET`    | JWT signing secret           | Yes                     |

### Example `.env`

```bash
PORT=3000
DATABASE_URL=postgresql://user:pass@db:5432/crawlee
REDIS_URL=redis://redis:6379
S3_ENDPOINT=https://s3.amazonaws.com
S3_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
S3_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_BUCKET=crawlee-cloud-storage
API_SECRET=your-secure-random-string
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
{ "status": "ok", "version": "0.1.0" }
```

---

## Backups

- **PostgreSQL**: Use `pg_dump` or managed backups
- **S3**: Enable bucket versioning
- **Redis**: Enable RDB/AOF persistence
