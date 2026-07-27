# Apify SDK Compatibility

Crawlee Cloud is fully compatible with the official [Apify SDK](https://docs.apify.com/sdk/js). Your existing Actors work without code changes.

## Configuration

Set these environment variables to point the SDK to your server:

```bash
export APIFY_API_BASE_URL=https://your-server.com/v2
export APIFY_TOKEN=your-api-token
```

That's it. Your Actor code works unchanged:

```typescript
import { Actor } from 'apify';

await Actor.init();

// All SDK methods work with Crawlee Cloud
await Actor.pushData({ title: 'Example' });
const input = await Actor.getInput();
await Actor.setValue('OUTPUT', results);

await Actor.exit();
```

---

## Injected Environment Variables

When the runner starts an Actor container, it injects the full Apify SDK environment (see `buildActorEnv` in `packages/runner/src/docker.ts`):

| Variable                           | Value                                                        |
| ---------------------------------- | ------------------------------------------------------------ |
| `APIFY_ACTOR_ID`                   | ID of the Actor being run                                    |
| `APIFY_ACTOR_RUN_ID`               | ID of the current run                                        |
| `APIFY_USER_ID`                    | Owning user's ID (`anonymous` if unknown)                    |
| `APIFY_API_BASE_URL`               | URL of the Crawlee Cloud API                                 |
| `APIFY_API_PUBLIC_BASE_URL`        | Same as `APIFY_API_BASE_URL`                                 |
| `APIFY_TOKEN`                      | API token the Actor uses for storage calls                   |
| `APIFY_DEFAULT_DATASET_ID`         | Default dataset for `Actor.pushData()`                       |
| `APIFY_DEFAULT_KEY_VALUE_STORE_ID` | Default KV store for `Actor.getInput()` / `Actor.setValue()` |
| `APIFY_DEFAULT_REQUEST_QUEUE_ID`   | Default request queue                                        |
| `APIFY_IS_AT_HOME`                 | `1`                                                          |
| `APIFY_HEADLESS`                   | `1`                                                          |
| `APIFY_MEMORY_MBYTES`              | Memory limit for this run                                    |
| `APIFY_TIMEOUT_AT`                 | ISO timestamp when the run times out                         |
| `APIFY_INPUT_KEY`                  | `INPUT`                                                      |
| `APIFY_CONTAINER_PORT`             | `4321`                                                       |
| `APIFY_CONTAINER_URL`              | `http://run-{runId}:4321`                                    |
| `CRAWLEE_STORAGE_DIR`              | `/tmp/storage`                                               |
| `APIFY_PROXY_PASSWORD`             | Only set when a proxy password is configured                 |
| `APIFY_PROXY_HOSTNAME`             | Only set when configured                                     |
| `APIFY_PROXY_PORT`                 | Only set when configured                                     |

When `APIFY_PROXY_PASSWORD` is not injected, the SDK falls back to resolving it via `GET /v2/users/me` (`data.proxy.password`).

---

## Supported Features

| Feature                                                | Status |
| ------------------------------------------------------ | ------ |
| `Actor.init()` / `Actor.exit()`                        | ✅     |
| `Actor.pushData()`                                     | ✅     |
| `Actor.getInput()`                                     | ✅     |
| `Actor.getValue()` / `Actor.setValue()`                | ✅     |
| `Actor.openDataset()`                                  | ✅     |
| `Actor.openKeyValueStore()`                            | ✅     |
| `Actor.openRequestQueue()`                             | ✅     |
| Request deduplication                                  | ✅     |
| Distributed locking                                    | ✅     |
| Webhooks (per-run + standalone CRUD)                   | ✅     |
| Schedules (cron-based Actor runs)                      | ✅     |
| Apify proxy password resolution via `GET /v2/users/me` | ✅     |
| Binary key-value store payloads                        | ✅     |
| Presigned record URLs / dataset download streaming     | ✅     |

---

## Local Testing

Test your Actor against your Crawlee Cloud instance:

```bash
APIFY_API_BASE_URL=http://localhost:3000/v2 \
APIFY_TOKEN=your-token \
npm start
```

Note: when the runner launches Actor containers on macOS, it rewrites `localhost` / `127.0.0.1` in the injected `APIFY_API_BASE_URL` to `host.docker.internal` so the container can reach the host-running API (see `translateLocalhostForContainer` in `packages/runner/src/docker.ts`). Set `API_BASE_URL` explicitly to bypass the rewrite.

---

## Pushing Actors

```bash
# Login to your server
crc login --url https://your-server.com

# Push your Actor
crc push my-actor
```

---

## Choose Your Setup

| Aspect  | Hosted (Apify)  | Self-Hosted (Crawlee Cloud) |
| ------- | --------------- | --------------------------- |
| Hosting | Managed for you | Your own servers            |
| Billing | Usage-based     | Your infrastructure         |
| Data    | Cloud storage   | Self-managed storage        |
| Scale   | Plan tiers      | Configure as needed         |
| Source  | Commercial      | Open source                 |
