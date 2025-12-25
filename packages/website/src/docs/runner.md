# Runner

The Runner executes Actors in isolated Docker containers.

## How It Works

1. Polls the job queue from Redis
2. Pulls the Actor's Docker image
3. Starts the container with environment variables
4. Streams logs to the API server
5. Cleans up after completion

---

## Configuration

| Variable         | Description               | Default                  |
| ---------------- | ------------------------- | ------------------------ |
| `API_URL`        | API server URL            | `http://localhost:3000`  |
| `REDIS_URL`      | Redis connection string   | `redis://localhost:6379` |
| `DOCKER_SOCKET`  | Docker socket path        | `/var/run/docker.sock`   |
| `MAX_CONCURRENT` | Max concurrent containers | `5`                      |
| `POLL_INTERVAL`  | Queue poll interval (ms)  | `1000`                   |

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
| `APIFY_DEFAULT_DATASET_ID`         | Default dataset for `pushData` |
| `APIFY_DEFAULT_KEY_VALUE_STORE_ID` | Default KV store               |
| `APIFY_DEFAULT_REQUEST_QUEUE_ID`   | Default request queue          |
| `ACTOR_RUN_ID`                     | Current run ID                 |

---

## Resource Limits

Configure container resource limits:

```bash
CONTAINER_MEMORY_LIMIT=1g
CONTAINER_CPU_LIMIT=1.0
```

---

## Graceful Shutdown

On SIGTERM/SIGINT:

1. Stop accepting new jobs
2. Wait for running containers to finish
3. Clean up resources
4. Exit
