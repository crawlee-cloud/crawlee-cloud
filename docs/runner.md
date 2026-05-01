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

| Variable               | Description                                                  | Default                                                       |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `API_BASE_URL`         | API server URL                                               | `http://localhost:3000`                                       |
| `API_TOKEN`            | Authentication token (auto-provisioned via Redis if not set) | Auto-provisioned                                              |
| `DATABASE_URL`         | PostgreSQL connection string                                 | `postgresql://postgres:postgres@localhost:5432/crawlee_cloud` |
| `REDIS_URL`            | Redis connection string                                      | `redis://localhost:6379`                                      |
| `DOCKER_SOCKET`        | Docker socket path                                           | `/var/run/docker.sock`                                        |
| `DOCKER_NETWORK`       | Docker network name                                          | `crawlee-cloud_default`                                       |
| `MAX_CONCURRENT_RUNS`  | Max concurrent containers                                    | `10`                                                          |
| `DEFAULT_MEMORY_MB`    | Default container memory (MB)                                | `1024`                                                        |
| `DEFAULT_TIMEOUT_SECS` | Default run timeout (seconds)                                | `3600`                                                        |
| `LOG_LEVEL`            | Log verbosity                                                | `info`                                                        |

> **Note:** On startup, the API server creates a dedicated runner API key and stores it in Redis. The runner automatically fetches this key. You only need to set `API_TOKEN` manually if running the runner outside of the standard Docker Compose setup.

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

| Variable                           | Description                    |
| ---------------------------------- | ------------------------------ |
| `APIFY_API_BASE_URL`               | Points to your API server      |
| `APIFY_TOKEN`                      | Authentication token           |
| `APIFY_ACTOR_RUN_ID`               | Current run ID                 |
| `APIFY_DEFAULT_DATASET_ID`         | Default dataset for `pushData` |
| `APIFY_DEFAULT_KEY_VALUE_STORE_ID` | Default KV store               |
| `APIFY_DEFAULT_REQUEST_QUEUE_ID`   | Default request queue          |

Environment variables are merged in order: base env < actor env (from actor.json) < runtime env (from CLI `-e` flag).

---

## Graceful Shutdown

On SIGTERM/SIGINT:

1. Stop accepting new jobs
2. Wait for running containers to finish
3. Clean up resources
4. Exit
