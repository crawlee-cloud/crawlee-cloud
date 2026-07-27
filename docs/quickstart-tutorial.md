# Quick Start Tutorial

Deploy your first scraper on Crawlee Cloud in under 10 minutes. This guide walks you through the entire process — from starting the platform to viewing your scraped data.

---

## Prerequisites

- **Docker** & **Docker Compose** (v2+)
- **Node.js** 20 or later
- **Git**

---

## Step 1: Start the Platform

Clone the repository and start the stack:

```bash
git clone https://github.com/crawlee-cloud/crawlee-cloud.git
cd crawlee-cloud
```

Start everything:

```bash
docker compose up -d
```

Then run the database migrations (they do not run automatically on container startup):

```bash
docker compose exec api node packages/api/dist/db/migrate.js
```

This brings up the API, Runner, Dashboard, Scheduler, PostgreSQL, Redis, and MinIO, plus a one-shot `minio-init` job that creates the storage bucket and exits.

::: warning Dev admin credentials
The stock `docker-compose.yml` hard-codes the admin login `admin@crawlee.cloud` / `crawlee.cloud` and does **not** read a `.env` file. `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env` only apply to the non-Docker flow and to the production Compose file (`deploy/vps/docker-compose.prod.yml`). Note that `.env.example` does not include these keys — add them if you use those flows.
:::

::: warning Docker network name
The stock compose file sets `DOCKER_NETWORK=crawlee-platfrom_crawlee-network` for the Runner, which only matches if your checkout directory is named `crawlee-platfrom`. If you cloned into a differently named directory, adjust that value to `<your-directory>_crawlee-network`.
:::

Wait a moment for services to initialize, then verify:

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"1.5.0"}   # version reflects the release you have installed
```

The **Dashboard** is available at `http://localhost:3001`.

---

## Step 2: Get an API Token

Log in with your admin credentials to get a JWT token (with the stock compose file, these are the dev defaults shown below):

```bash
curl -s -X POST http://localhost:3000/v2/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@crawlee.cloud","password":"crawlee.cloud"}'
```

The response contains your token:

```json
{
  "data": {
    "user": { "id": "...", "email": "admin@crawlee.cloud" },
    "token": "eyJhbGciOiJIUzI1NiIs..."
  }
}
```

Save the token — you will need it for the next steps:

```bash
export TOKEN="eyJhbGciOiJIUzI1NiIs..."
```

::: tip
For long-lived access, create an API key instead of using JWT tokens (which expire). Go to the Dashboard **Settings → API Keys**, or use the API:

```bash
curl -X POST http://localhost:3000/v2/auth/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-cli-key"}'
```

The returned `key` (starting with `cp_`) can be used as a `Bearer` token that does not expire.
:::

---

## Step 3: Create Your Scraper

Create a project directory with a simple scraper:

```bash
mkdir my-scraper && cd my-scraper
```

Create **`package.json`**:

```json
{
  "name": "my-scraper",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "apify": "^3.1.0",
    "crawlee": "^3.5.0"
  }
}
```

Create **`src/main.js`** — a simple scraper that extracts page titles:

```javascript
import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';

await Actor.init();

const crawler = new CheerioCrawler({
  maxRequestsPerCrawl: 5,
  async requestHandler({ request, $ }) {
    const title = $('title').text().trim();
    console.log(`Scraped: ${request.url} → ${title}`);
    await Actor.pushData({ url: request.url, title });
  },
});

await crawler.run(['https://crawlee.dev']);
await Actor.exit();
```

::: info How it works
The scraper uses the standard **Apify SDK** (`Actor.init()`, `Actor.pushData()`) which automatically connects to Crawlee Cloud's API when the `APIFY_API_BASE_URL` environment variable is set. No code changes needed — the same Actor works on Apify's platform, Crawlee Cloud, or locally.
:::

Create **`Dockerfile`**:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "src/main.js"]
```

Create **`.actor/actor.json`** — metadata that tells the platform about your Actor:

```json
{
  "actorSpecification": 1,
  "name": "my-scraper",
  "version": "1.0.0"
}
```

::: warning
The `actor.json` must be inside a `.actor/` directory (not the project root). The CLI requires this convention.
:::

---

## Step 4: Push the Actor

You have two options to push your Actor to the platform.

### Option A: Using the CLI

Install the CLI and log in:

```bash
npm install -g @crawlee-cloud/cli

# Non-interactive login with URL and token
crawlee-cloud login --url http://localhost:3000 --token <your-api-key>
```

Then push from your project directory:

```bash
crawlee-cloud push
```

This builds the Docker image and registers the Actor with the platform.

::: warning Docker required
`crawlee-cloud push` builds the Docker image on your machine. Make sure Docker Desktop (or Docker Engine) is running. If you don't have Docker locally, use Option B instead.
:::

### Option B: Using the API directly

Build the Docker image on the machine where the Runner is running (it needs access to the image):

```bash
docker build -t crawlee-cloud/actor-my-scraper:latest .
```

Register the Actor with the API:

```bash
curl -X POST http://localhost:3000/v2/acts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-scraper","title":"My Scraper"}'
```

::: tip
The Runner uses the naming convention `crawlee-cloud/actor-{name}:latest` to find Docker images. As long as your image matches this pattern, the Runner will find it automatically.
:::

---

## Step 5: Run the Actor

### Using the CLI

```bash
crawlee-cloud call my-scraper --wait
```

### Using the API

```bash
curl -X POST http://localhost:3000/v2/acts/my-scraper/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

This returns a run object with the run ID and status:

```json
{
  "data": {
    "id": "abc123",
    "status": "READY",
    "defaultDatasetId": "def456"
  }
}
```

The Runner picks up `READY` runs within seconds, spawns a Docker container, and executes your Actor. You can poll the status:

```bash
curl http://localhost:3000/v2/actor-runs/abc123 \
  -H "Authorization: Bearer $TOKEN"
```

Or stream logs in real time:

```bash
crawlee-cloud logs abc123 --follow
```

---

## Step 6: View Results

Once the run status is `SUCCEEDED`, fetch the scraped data from the dataset:

### Via the API

```bash
curl http://localhost:3000/v2/datasets/def456/items \
  -H "Authorization: Bearer $TOKEN"
```

Response:

```json
[
  {
    "url": "https://crawlee.dev",
    "title": "Crawlee · Build reliable crawlers. Fast."
  }
]
```

### Via the Dashboard

Open `http://localhost:3001` in your browser and navigate to:

- **Runs** — see execution history and statuses
- **Datasets** — browse and download scraped data
- **Actors** — manage your deployed scrapers

---

## Deploying to Production

### VPS (Single Server)

Deploy the full stack on any VPS with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/crawlee-cloud/crawlee-cloud/main/deploy/vps/deploy.sh | bash
```

### DigitalOcean (Managed Infrastructure)

Deploy with managed databases and auto-scaling:

```bash
git clone https://github.com/crawlee-cloud/crawlee-cloud.git
cd crawlee-cloud
bash deploy/digitalocean/setup.sh
```

This creates managed PostgreSQL, Redis, App Platform (API + Dashboard), and a Runner Droplet — everything in one command.

See the [Deployment Guide](./deployment.md) for all options including Railway, Render, and Kubernetes.

---

## What's Next

- **[CLI Guide](./cli.md)** — Full command reference including `dev` mode for local iteration
- **[API Reference](./api.md)** — Manage datasets, key-value stores, request queues, and runs via REST
- **[Apify SDK Compatibility](./apify-sdk-environment.md)** — Your existing Apify Actors work without code changes
- **[Runner](./runner.md)** — How the execution engine works
- **[Dashboard Guide](./dashboard.md)** — Get the most out of the web UI

If you run into issues, check [GitHub Issues](https://github.com/crawlee-cloud/crawlee-cloud/issues) or start a [Discussion](https://github.com/crawlee-cloud/crawlee-cloud/discussions).

---

## Tell Us How It Went

You just deployed (or tried to deploy) Crawlee Cloud — that makes you exactly the person whose feedback matters most right now.

- **[File a deployment report](https://github.com/crawlee-cloud/crawlee-cloud/issues/new?template=deployment_report.yml)** — 5 minutes of honest notes: what was confusing, what almost made you give up. Nothing needs to be broken to file one.
- **Stuck?** [Email the maintainer](mailto:aminembarki@gmail.com?subject=crawlee-cloud%20setup%20help) for free 15-minute setup help — the only price is your candid feedback.
