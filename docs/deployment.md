# Deployment Guide

Deploy Crawlee Cloud to your own infrastructure.

## Requirements

- Docker and Docker Compose
- Node.js 18+
- PostgreSQL 14+
- Redis 6+
- S3-compatible storage (MinIO, AWS S3, etc.)

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/crawlee-cloud.git
cd crawlee-cloud
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings
```

### 3. Start Infrastructure

```bash
docker compose up -d
```

### 4. Build and Run

```bash
npm install
npm run build
npm run db:migrate
npm run dev
```

## Production Deployment

### Using Docker Compose

```bash
docker compose -f docker-compose.yml up -d
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | - |
| `REDIS_URL` | Redis connection string | - |
| `S3_ENDPOINT` | S3-compatible endpoint | - |
| `S3_ACCESS_KEY` | S3 access key | - |
| `S3_SECRET_KEY` | S3 secret key | - |
| `S3_BUCKET` | S3 bucket name | - |
| `API_SECRET` | JWT signing secret | - |

### Scaling

- **API Server**: Stateless, scale horizontally
- **Runner**: Scale based on workload
- **PostgreSQL**: Use managed service for HA
- **Redis**: Use Redis Cluster for scale

## Health Checks

```bash
curl http://localhost:3000/health
```

## Backups

- PostgreSQL: Use `pg_dump` for regular backups
- S3: Enable versioning on your bucket
- Redis: Enable RDB persistence
