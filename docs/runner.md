# Runner

The Runner executes Actors in isolated Docker containers.

## How It Works

1. Polls PostgreSQL for runs with `READY` status (using `FOR UPDATE SKIP LOCKED`)
2. Subscribes to Redis `run:new` channel for instant notifications
3. Fetches runner API key from Redis (if not already loaded)
4. Pulls the Actor's Docker image and starts the container
5. Streams logs to Redis during execution
6. Updates run status and cleans up after completion

---

## Configuration

| Variable                     | Description                                                                                                                                                                                    | Default                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `API_BASE_URL`               | API server URL                                                                                                                                                                                 | `http://localhost:3000`                                       |
| `API_TOKEN`                  | Fallback authentication token. At runtime the runner prefers the auto-provisioned key stored in Redis at `runner:api-key`; this value is only used until/unless that key is available.         | `runner-token`                                                |
| `DATABASE_URL`               | PostgreSQL connection string                                                                                                                                                                   | `postgresql://postgres:postgres@localhost:5432/crawlee_cloud` |
| `REDIS_URL`                  | Redis connection string                                                                                                                                                                        | `redis://localhost:6379`                                      |
| `DOCKER_SOCKET`              | Docker socket path                                                                                                                                                                             | `/var/run/docker.sock`                                        |
| `DOCKER_NETWORK`             | Docker network name                                                                                                                                                                            | `crawlee-cloud_default`                                       |
| `IMAGE_REGISTRY`             | Registry to pull actor images from (e.g. `ghcr.io/your-org`). Empty means local image builds. Also used by the auto-scaler — see [Cloud / registry credentials](#cloud--registry-credentials). | _(empty)_                                                     |
| `IMAGE_REGISTRY_USER`        | Username for the registry login                                                                                                                                                                | _(empty)_                                                     |
| `IMAGE_REGISTRY_TOKEN`       | Token / password for the registry login                                                                                                                                                        | _(empty)_                                                     |
| `MAX_CONCURRENT_RUNS`        | Max concurrent containers                                                                                                                                                                      | `10`                                                          |
| `DEFAULT_MEMORY_MB`          | Default container memory (MB)                                                                                                                                                                  | `1024`                                                        |
| `DEFAULT_TIMEOUT_SECS`       | Default run timeout (seconds)                                                                                                                                                                  | `3600`                                                        |
| `HOST_TOTAL_MEMORY_MB`       | Host RAM the memory admission gate budgets against. Override for exotic setups where the runner's view of RAM isn't the actors' host.                                                          | Detected physical RAM                                         |
| `RUNNER_MEMORY_RESERVE_MB`   | RAM held back for the OS, dockerd, and the runner process itself                                                                                                                               | `768`                                                         |
| `RUNNER_MAX_READY_WAIT_SECS` | How long an unfittable `READY` run may wait before busy hosts stop claiming past it and drain toward idle                                                                                      | `300`                                                         |
| `APIFY_PROXY_PASSWORD`       | Platform-level fallback proxy password injected into actor containers                                                                                                                          | _(empty)_                                                     |
| `APIFY_PROXY_HOSTNAME`       | Proxy hostname override. Empty means the SDK default (`proxy.apify.com`).                                                                                                                      | _(empty)_                                                     |
| `APIFY_PROXY_PORT`           | Proxy port override. `0` means the SDK default (`8000`).                                                                                                                                       | `0`                                                           |
| `RUNNER_ID`                  | Identity used for heartbeats and cost attribution. On DigitalOcean, cloud-init pins it to the droplet ID.                                                                                      | Hostname                                                      |
| `RUNNER_PRICE_HOURLY`        | Hourly price stamped onto claimed runs for cost analysis. Unset means "not recorded" in cost views.                                                                                            | _(unset)_                                                     |
| `RUNNER_PROVIDER`            | Provider label stamped onto claimed runs (`digitalocean` via cloud-init)                                                                                                                       | `local-docker`                                                |
| `SHUTDOWN_TIMEOUT_SECS`      | Grace period for running containers before a forced exit on shutdown                                                                                                                           | `60`                                                          |
| `PROXY_ENCRYPTION_KEY`       | ⚠️ **Required in production** — see below.                                                                                                                                                     | _(unset)_                                                     |
| `LOG_LEVEL`                  | Log verbosity                                                                                                                                                                                  | `info`                                                        |

> **Note:** On startup, the API server creates a dedicated runner API key and stores it in Redis. The runner automatically fetches this key. You only need to set `API_TOKEN` manually if running the runner outside of the standard Docker Compose setup.

> **⚠️ `PROXY_ENCRYPTION_KEY`:** the runner **exits fatally at startup in production** (`NODE_ENV=production`) if this is unset. It must be exactly 64 hex characters (32 bytes) and **identical to the value on the API server** — both processes encrypt/decrypt the same database columns. If it is unset outside production, the key is derived as a fallback from `sha256(API_SECRET)`, which must then also match on both processes; a mismatch makes every decrypt fail silently and runs proceed without their resolved proxy credentials. Generate one with:
>
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## Service Authentication

The runner authenticates with the API server using an auto-provisioned API key:

1. During startup, the API server creates a `cp_`-prefixed API key dedicated to the runner.
2. This key is stored in Redis at `runner:api-key`.
3. On initialization, the runner fetches the key from Redis and uses it as the `APIFY_TOKEN` injected into Actor containers.
4. If the runner starts before the API server is ready, it retries fetching the key on each run.

This removes the need for a hardcoded token and ensures the runner always has a valid credential.

---

## Running

```bash
cd packages/runner
npm run build
npm start
```

### Docker Mode

The Runner needs access to the Docker socket:

```bash
docker run \
  -v /var/run/docker.sock:/var/run/docker.sock \
  crawlee-cloud/runner
```

---

## Container Lifecycle

| Phase   | Description                        |
| ------- | ---------------------------------- |
| Pull    | Download Actor image from registry |
| Create  | Create container with environment  |
| Start   | Execute the container              |
| Monitor | Stream logs, wait for exit         |
| Cleanup | Remove container                   |

---

## Actor Environment Variables

The Runner injects these variables into Actor containers:

| Variable                           | Description                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `APIFY_ACTOR_ID`                   | ID of the Actor being run                                                                            |
| `APIFY_ACTOR_RUN_ID`               | Current run ID                                                                                       |
| `APIFY_USER_ID`                    | Owner of the run (`anonymous` when unknown)                                                          |
| `APIFY_API_BASE_URL`               | Points to your API server                                                                            |
| `APIFY_API_PUBLIC_BASE_URL`        | Public API URL (same value as `APIFY_API_BASE_URL`)                                                  |
| `APIFY_TOKEN`                      | Authentication token                                                                                 |
| `APIFY_DEFAULT_DATASET_ID`         | Default dataset for `pushData`                                                                       |
| `APIFY_DEFAULT_KEY_VALUE_STORE_ID` | Default KV store                                                                                     |
| `APIFY_DEFAULT_REQUEST_QUEUE_ID`   | Default request queue                                                                                |
| `APIFY_IS_AT_HOME`                 | Set to `1` so the SDK behaves as if running on the platform                                          |
| `APIFY_HEADLESS`                   | Set to `1` to force headless browsers                                                                |
| `APIFY_MEMORY_MBYTES`              | Memory limit for the run (MB)                                                                        |
| `APIFY_TIMEOUT_AT`                 | ISO timestamp when the run times out                                                                 |
| `APIFY_INPUT_KEY`                  | KV store key holding the run input (`INPUT`)                                                         |
| `APIFY_CONTAINER_PORT`             | Port the Actor may listen on (`4321`)                                                                |
| `APIFY_CONTAINER_URL`              | URL of the run container (`http://run-<runId>:4321`)                                                 |
| `CRAWLEE_STORAGE_DIR`              | Local storage dir for newer crawlers (`/tmp/storage`)                                                |
| `APIFY_PROXY_PASSWORD`             | Resolved proxy password — only set when a proxy resolves (see [Proxy Resolution](#proxy-resolution)) |
| `APIFY_PROXY_HOSTNAME`             | Proxy hostname — only set when configured                                                            |
| `APIFY_PROXY_PORT`                 | Proxy port — only set when configured                                                                |

Environment variables are merged in order: base env < actor env (from actor.json) < runtime env (from CLI `-e` flag).

---

## Graceful Shutdown

On SIGTERM/SIGINT:

1. Stop accepting new jobs
2. Wait for running containers to finish (up to `SHUTDOWN_TIMEOUT_SECS`, then force exit)
3. Clean up resources
4. Exit

---

## Heartbeat

Every 30 seconds the runner publishes system metrics (CPU, memory, disk, active run IDs, capacity, health) to Redis at `runner:heartbeat:{runnerId}` with a 90-second TTL — if the runner dies, its heartbeat expires automatically. The auto-scaler and the dashboard's Runners page read these keys to track live runner state.

---

## Memory Admission Control

Before claiming a run, the runner checks that the sum of active containers' memory limits plus the new run's limit fits under `HOST_TOTAL_MEMORY_MB - RUNNER_MEMORY_RESERVE_MB`. Runs that don't fit are left for another runner, preventing coincident memory peaks from OOM-ing the host. If an unfittable `READY` run has waited longer than `RUNNER_MAX_READY_WAIT_SECS`, busy hosts stop claiming past it and drain toward idle so it isn't starved forever.

At claim time the runner also stamps cost attribution onto the run — `runner_id`, `runner_price_hourly` (from `RUNNER_PRICE_HOURLY`), and `runner_provider` — which powers the dashboard's per-run cost views.

---

## Proxy Resolution

Proxy credentials are resolved per run in three tiers: actor-level, then user-level, then the platform default (`APIFY_PROXY_PASSWORD`). Stored credentials are encrypted with AES-256-GCM and decrypted using `PROXY_ENCRYPTION_KEY` (shared with the API server). The winning tier is logged to the run's lifecycle log for triage — never the credential itself — and the resolved values are injected into the container as `APIFY_PROXY_*` variables.

---

## Webhook Delivery

On run completion the runner delivers webhooks with Apify-compatible payloads. Custom `payload_template` strings go through a template engine (`{{key}}` substitution with dot-notation lookups) that is kept byte-identical to the API's "test webhook" path, so a template verified in the dashboard behaves the same in production. Failed deliveries are picked up by a retry processor that runs every 10 seconds.

---

## Auto-scaling

The API server can automatically provision and destroy runner VMs based on queue pressure. Disabled by default — set `SCALER_ENABLED=true` to opt in. Has zero impact on single-Droplet or docker-compose deployments.

### Providers

| Provider       | When to use                                                                              |
| -------------- | ---------------------------------------------------------------------------------------- |
| `noop`         | Default. Scaler runs but takes no action. Useful for testing config.                     |
| `local-docker` | Spins up runner containers on the same Docker daemon. Dev / single-host setups.          |
| `digitalocean` | Creates and destroys DigitalOcean Droplets. Requires `DO_TOKEN` and `SCALER_SSH_KEY_ID`. |

### Core scaler variables

| Variable                        | Default       | Description                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SCALER_ENABLED`                | `false`       | Set to `true` to start the scaling loop.                                                                                                                                                                                                                                 |
| `SCALER_PROVIDER`               | `noop`        | One of `noop`, `local-docker`, `digitalocean`.                                                                                                                                                                                                                           |
| `SCALER_MIN_RUNNERS`            | `1`           | Minimum runners kept warm at all times.                                                                                                                                                                                                                                  |
| `SCALER_MAX_RUNNERS`            | `5`           | Hard cap on provisioned runners. Clamped to `>= MIN_RUNNERS`.                                                                                                                                                                                                            |
| `SCALER_SCALE_UP_THRESHOLD`     | `5`           | Don't scale up unless `READY` queue depth exceeds this (and we're already at `MIN_RUNNERS`).                                                                                                                                                                             |
| `SCALER_RUNS_PER_RUNNER`        | `5`           | How many concurrent runs each runner can handle. Drives demand math: `desired = ceil(totalDemand / runsPerRunner)`.                                                                                                                                                      |
| `SCALER_POLL_INTERVAL_SECS`     | `30`          | How often the scaler evaluates demand.                                                                                                                                                                                                                                   |
| `SCALER_IDLE_TIMEOUT_SECS`      | `600`         | After the queue empties, wait this long before scaling down. Avoids thrashing during natural lulls.                                                                                                                                                                      |
| `SCALER_REAPER_DEAD_AFTER_SECS` | `180`         | A booting runner with no heartbeat for longer than this is marked `dead` and destroyed. Bump on slow apt mirrors.                                                                                                                                                        |
| `SCALER_MAX_READY_WAIT_SECS`    | `300`         | Starvation escalation: once the oldest `READY` run has waited longer than this, provision one extra runner even when demand math says none is needed. The capacity-side half of starvation protection; the runner's `RUNNER_MAX_READY_WAIT_SECS` is the claim-side half. |
| `SCALER_RUNNER_SIZE`            | `s-2vcpu-4gb` | Provider-specific instance size (DigitalOcean droplet slug).                                                                                                                                                                                                             |
| `SCALER_RUNNER_REGION`          | `nyc1`        | Provider-specific region.                                                                                                                                                                                                                                                |
| `SCALER_SSH_KEY_ID`             | _(empty)_     | DigitalOcean SSH key fingerprint or ID — required for `digitalocean` provider so you can shell in for forensics.                                                                                                                                                         |
| `SCALER_API_BASE_URL`           | _(empty)_     | URL the freshly-booted runner will call back to. Must be reachable from the runner VM.                                                                                                                                                                                   |

### Cloud / registry credentials

| Variable               | Default   | Description                                                                                                                       |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DO_TOKEN`             | _(empty)_ | DigitalOcean API token. `DIGITALOCEAN_TOKEN` is accepted as an alias.                                                             |
| `IMAGE_REGISTRY`       | _(empty)_ | Registry to pull actor images from (e.g. `ghcr.io/your-org`). Without it, runners require local image builds.                     |
| `IMAGE_REGISTRY_USER`  | _(empty)_ | Username for the registry login.                                                                                                  |
| `IMAGE_REGISTRY_TOKEN` | _(empty)_ | Token / password for the registry login.                                                                                          |
| `GHCR_TOKEN`           | _(empty)_ | GitHub Container Registry PAT. Inlined into the runner's cloud-init so it can `docker login ghcr.io` before pulling actor images. |
| `GHCR_REPO`            | _(empty)_ | GHCR repository slug used for image lookups.                                                                                      |

### Security flags

| Variable              | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCALER_INSECURE_TLS` | `false` | ⚠️ **Opt-in TLS bypass.** When `true`, freshly-provisioned runners boot with `NODE_TLS_REJECT_UNAUTHORIZED=0`, disabling cert verification on every outbound HTTPS call. Only valid use case: trusted internal CAs / self-signed certs the runner can't otherwise verify. The API logs a warning at startup when set. **Do not enable on the public internet** — every call to your API, S3, or registries becomes MITM-vulnerable. |
| `METRICS_PUBLIC`      | `false` | When `true`, `GET /metrics` is exposed without auth. By default the endpoint is admin-only because it leaks process internals and per-route counters useful for fingerprinting. Use only when your Prometheus scraper can't pass an `Authorization` header (private network).                                                                                                                                                       |

### Status endpoint

`GET /v2/scaler/status` (admin-only) returns the live runner list, heartbeats, queue stats, and config. There is intentionally no `_PUBLIC` flag — the response includes runner IPs and provider config that have no public use case.

### Operational notes

- **Cloud-init secrets:** the cloud-init script that bootstraps each runner contains `DATABASE_URL`, `REDIS_URL`, and registry tokens in plaintext. On DigitalOcean this is readable from the metadata service (`http://169.254.169.254/metadata/v1/user-data`) by anything running on the VM, including actor containers if you don't firewall the metadata IP. Treat runner VMs as having access to those secrets.
- **Scaling math:** `desired = ceil((ready + running) / runsPerRunner)`, clamped to `[MIN_RUNNERS, MAX_RUNNERS]`. When the queue is empty, scale-down only happens after `IDLE_TIMEOUT_SECS` of continuous idleness — preventing churn during normal traffic dips.
- **Reaper:** runners with no heartbeat for `REAPER_DEAD_AFTER_SECS` are marked `dead` and destroyed every tick, independent of demand. Failed destroys stay in the runner list so the next tick retries — this preserves capacity accounting.
