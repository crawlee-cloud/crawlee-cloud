# Deploy Crawlee Cloud

Choose your deployment method:

## One-Click Deploy (PaaS) — Two Steps

**Step 1:** Deploy API + Dashboard + managed databases with one click:

| Provider     | Deploy                                                                                                                                                                               | Notes                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Railway      | [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/crawlee-cloud/crawlee-cloud&referralCode=crawlee)                | Includes PostgreSQL + Redis. Easiest setup. |
| Render       | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/crawlee-cloud/crawlee-cloud)                          | Free tier available.                        |
| DigitalOcean | [![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/crawlee-cloud/crawlee-cloud/tree/main&refcode=crawlee) | Managed PostgreSQL + Redis.                 |

**Step 2:** Connect a Runner on a $5 VPS so Actors can execute. See [Connecting a Runner](#connecting-a-runner-required-for-paas-deployments) below.

> **Why two steps?** The Runner needs Docker socket access to spawn Actor containers, which PaaS platforms don't provide. A cheap VPS ($5/month) handles this perfectly.

## DigitalOcean (Automated Full Stack)

Deploys the entire stack with a single script: API + Dashboard on App Platform, Runner on a Droplet, managed PostgreSQL and Redis clusters.

### Prerequisites

- [doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) installed and authenticated (`doctl auth init`)
- An SSH key added to your DO account

### Deploy

```bash
git clone https://github.com/crawlee-cloud/crawlee-cloud.git
cd crawlee-cloud
bash deploy/digitalocean/setup.sh
```

The script will:

1. Create a managed PostgreSQL cluster (`crawlee-cloud-db`)
2. Create a managed Redis/Valkey cluster (`crawlee-cloud-redis`)
3. Deploy API + Dashboard on App Platform (auto-runs migrations)
4. Create a Runner Droplet with Docker pre-installed
5. Configure the Runner with database/Redis connection strings
6. Print admin credentials, URLs, and management commands

### Cost

| Component                      | Size         | Monthly     |
| ------------------------------ | ------------ | ----------- |
| App Platform (API + Dashboard) | basic-s x2   | ~$12        |
| PostgreSQL (managed)           | 1 vCPU / 1GB | ~$15        |
| Redis/Valkey (managed)         | 1 vCPU / 1GB | ~$15        |
| Runner Droplet                 | 1 vCPU / 2GB | ~$12        |
| **Total**                      |              | **~$54/mo** |

### Architecture

```
                    DigitalOcean App Platform
                   ┌─────────────────────────┐
  Users ──────────>│  API        Dashboard   │
                   │  (Fastify)  (Next.js)   │
                   └────────┬────────────────┘
                            │
              ┌─────────────┼─────────────┐
              v             v             v
         PostgreSQL      Redis       DO Spaces
         (managed)     (Valkey)      (S3 storage)
              ^             ^
              │             │
                   ┌────────┴────────┐
                   │  Runner Droplet │
                   │  (Docker host)  │
                   └─────────────────┘
```

### Note on S3 Storage

The setup script configures placeholder values for S3. After deployment, create a [DO Spaces](https://cloud.digitalocean.com/spaces) bucket and update the `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` in the App Platform dashboard.

## Full Stack on VPS

Deploys everything (API + Dashboard + Runner + databases) on a single VPS with automatic HTTPS via Caddy.

### Requirements

- Ubuntu 22.04+ VPS (DigitalOcean Droplet, Hetzner, Linode, etc.)
- A domain name pointed to your server's IP
- Ports 80 and 443 open

### Deploy

SSH into your server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/crawlee-cloud/crawlee-cloud/main/deploy/vps/deploy.sh | bash
```

Or clone and run manually:

```bash
git clone https://github.com/crawlee-cloud/crawlee-cloud.git
cd crawlee-cloud
bash deploy/vps/deploy.sh
```

The script will:

1. Prompt for your domain and admin email
2. Install Docker (if needed)
3. Generate all secrets automatically
4. Start all services with Caddy for auto-HTTPS
5. Print your admin credentials and URLs

### DNS Setup

Point these DNS records to your server's IP:

- `crawlee.yourdomain.com` (A record) - API
- `dashboard.crawlee.yourdomain.com` (A record) - Dashboard

Caddy will automatically provision HTTPS certificates via Let's Encrypt once DNS is active.

### Management

```bash
cd /opt/crawlee-cloud/deploy/vps

# View logs
docker compose -f docker-compose.prod.yml logs -f

# Restart
docker compose -f docker-compose.prod.yml restart

# Stop
docker compose -f docker-compose.prod.yml down

# Update
cd /opt/crawlee-cloud && git pull
cd deploy/vps && docker compose -f docker-compose.prod.yml up -d --build
```

## Connecting a Runner (required for PaaS deployments)

PaaS platforms (Railway, Render, DO) can't run Actors because they don't provide Docker socket access. You need a separate Runner on a cheap VPS ($5/month DigitalOcean Droplet or Hetzner server is enough).

### What you need from your PaaS deployment

Before starting, grab these 4 values from your PaaS dashboard:

| Value            | Where to find it                                                                     |
| ---------------- | ------------------------------------------------------------------------------------ |
| **API URL**      | Your deployed API service URL (e.g. `https://crawlee-api-production.up.railway.app`) |
| **API Secret**   | The `API_SECRET` environment variable in your API service                            |
| **Database URL** | The `DATABASE_URL` from your managed PostgreSQL addon                                |
| **Redis URL**    | The `REDIS_URL` from your managed Redis addon                                        |

### Quick setup (recommended)

SSH into your VPS and run:

```bash
curl -fsSL https://raw.githubusercontent.com/crawlee-cloud/crawlee-cloud/main/deploy/runner/deploy-runner.sh | bash
```

The script will prompt for the 4 values above, install Docker if needed, and start the Runner.

### Manual setup

If you prefer to set things up manually:

```bash
git clone https://github.com/crawlee-cloud/crawlee-cloud.git
cd crawlee-cloud
bash deploy/runner/deploy-runner.sh
```

### Verifying the connection

Once the Runner is running, you should see it picking up jobs:

```bash
cd /opt/crawlee-cloud-runner/deploy/runner
docker compose -f docker-compose.runner.yml logs -f
```

Try starting an Actor run from the Dashboard or API — you should see the Runner pick it up within seconds.

### Runner management

```bash
cd /opt/crawlee-cloud-runner/deploy/runner

# View logs
docker compose -f docker-compose.runner.yml logs -f

# Stop
docker compose -f docker-compose.runner.yml down

# Update
cd /opt/crawlee-cloud-runner && git pull
cd deploy/runner && docker compose -f docker-compose.runner.yml up -d --build
```
