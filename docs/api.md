# API Reference

Crawlee Cloud provides a REST API that is fully compatible with the [Apify API v2](https://docs.apify.com/api/v2).

## Base URL

```
https://your-server.com/v2
```

## Authentication

All requests require a Bearer token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-server.com/v2/datasets
```

All resource endpoints are user-scoped — authenticated users can only access their own resources.

---

## Datasets

Store and retrieve scraped data.

| Method   | Endpoint                  | Description           |
| -------- | ------------------------- | --------------------- |
| `GET`    | `/v2/datasets`            | List all datasets     |
| `POST`   | `/v2/datasets`            | Create a new dataset  |
| `GET`    | `/v2/datasets/{id}`       | Get dataset details   |
| `DELETE` | `/v2/datasets/{id}`       | Delete a dataset      |
| `POST`   | `/v2/datasets/{id}/items` | Push items to dataset |
| `GET`    | `/v2/datasets/{id}/items` | Retrieve items        |

### Push Items

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"title": "Item 1"}, {"title": "Item 2"}]' \
  https://your-server.com/v2/datasets/{id}/items
```

### Retrieve Items

Supports pagination with `offset` and `limit` query parameters (max limit: 1000).

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-server.com/v2/datasets/{id}/items?offset=0&limit=100"
```

---

## Key-Value Stores

Store arbitrary data by key.

| Method   | Endpoint                                  | Description        |
| -------- | ----------------------------------------- | ------------------ |
| `GET`    | `/v2/key-value-stores`                    | List all stores    |
| `POST`   | `/v2/key-value-stores`                    | Create a new store |
| `GET`    | `/v2/key-value-stores/{id}`               | Get store details  |
| `DELETE` | `/v2/key-value-stores/{id}`               | Delete a store     |
| `PUT`    | `/v2/key-value-stores/{id}/records/{key}` | Set a record       |
| `GET`    | `/v2/key-value-stores/{id}/records/{key}` | Get a record       |
| `DELETE` | `/v2/key-value-stores/{id}/records/{key}` | Delete a record    |

### Common Keys

- `INPUT` — Actor input configuration
- `OUTPUT` — Actor output/results

---

## Request Queues

Manage URLs to crawl with automatic deduplication.

| Method   | Endpoint                                            | Description               |
| -------- | --------------------------------------------------- | ------------------------- |
| `GET`    | `/v2/request-queues`                                | List all queues           |
| `POST`   | `/v2/request-queues`                                | Create a new queue        |
| `GET`    | `/v2/request-queues/{id}`                           | Get queue details         |
| `DELETE` | `/v2/request-queues/{id}`                           | Delete a queue            |
| `GET`    | `/v2/request-queues/{id}/head`                      | Get next pending requests |
| `POST`   | `/v2/request-queues/{id}/head/lock`                 | Lock and fetch requests   |
| `POST`   | `/v2/request-queues/{id}/requests`                  | Add request to queue      |
| `POST`   | `/v2/request-queues/{id}/requests/batch`            | Batch add requests        |
| `GET`    | `/v2/request-queues/{id}/requests/{requestId}`      | Get request details       |
| `PUT`    | `/v2/request-queues/{id}/requests/{requestId}`      | Update request status     |
| `PUT`    | `/v2/request-queues/{id}/requests/{requestId}/lock` | Prolong request lock      |
| `DELETE` | `/v2/request-queues/{id}/requests/{requestId}/lock` | Release a lock            |

### Deduplication

Requests are deduplicated by `uniqueKey`. Adding a request with an existing `uniqueKey` is a no-op.

### Locking

The lock endpoint (`POST .../head/lock`) supports distributed crawling. Parameters:

- `lockSecs` — Lock duration in seconds (max 86400)
- `limit` — Number of requests to fetch (max 1000)
- `clientKey` — Unique identifier for the crawling client

---

## Actors

Manage Actor definitions.

| Method   | Endpoint             | Description       |
| -------- | -------------------- | ----------------- |
| `GET`    | `/v2/acts`           | List all Actors   |
| `POST`   | `/v2/acts`           | Create an Actor   |
| `GET`    | `/v2/acts/{id}`      | Get Actor details |
| `PUT`    | `/v2/acts/{id}`      | Update an Actor   |
| `DELETE` | `/v2/acts/{id}`      | Delete an Actor   |
| `POST`   | `/v2/acts/{id}/runs` | Start a new run   |

### Input Validation

Actor create/update bodies are validated with the following constraints:

- `name` — 1-100 chars, alphanumeric with dots, dashes, underscores
- `timeout` — Max 86400 seconds (24h)
- `memory` — Max 16384 MB (16 GB)

---

## Runs

Monitor Actor executions.

| Method | Endpoint                                            | Description               |
| ------ | --------------------------------------------------- | ------------------------- |
| `GET`  | `/v2/actor-runs`                                    | List all runs             |
| `GET`  | `/v2/actor-runs/{id}`                               | Get run status            |
| `PUT`  | `/v2/actor-runs/{id}`                               | Update run status         |
| `POST` | `/v2/actor-runs/{id}/abort`                         | Abort a running Actor     |
| `POST` | `/v2/actor-runs/{id}/resurrect`                     | Resurrect a failed run    |
| `GET`  | `/v2/actor-runs/{id}/logs`                          | Get run logs              |
| `POST` | `/v2/actor-runs/{id}/logs`                          | Append log entry          |
| `GET`  | `/v2/actor-runs/{id}/dataset/items`                 | Get run's dataset items   |
| `GET`  | `/v2/actor-runs/{id}/key-value-store/records/{key}` | Get run's KV store record |

### Run Status Values

| Status      | Description              |
| ----------- | ------------------------ |
| `READY`     | Queued, waiting to start |
| `RUNNING`   | Currently executing      |
| `SUCCEEDED` | Completed successfully   |
| `FAILED`    | Execution failed         |
| `ABORTED`   | Manually stopped         |
| `TIMED-OUT` | Exceeded time limit      |

### Run response shape (v1.0-committed)

Every endpoint that returns a run (LIST, GET-by-id, PUT, abort, resurrect) emits the same shape. Notable fields:

| Field                       | Type             | Notes                                                                                                                                                                                                                                                                              |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | string           | Apify-style 21-char nanoid.                                                                                                                                                                                                                                                        |
| `actId`                     | string           | Owning actor id.                                                                                                                                                                                                                                                                   |
| `status`                    | enum             | See "Run Status Values" above.                                                                                                                                                                                                                                                     |
| `defaultDatasetId`          | string \| null   | Dataset created at run start; null if the run failed before SDK init.                                                                                                                                                                                                              |
| `defaultDatasetItemCount`   | number \| null   | **Live count** from `datasets.item_count`, joined per-request. Null when there is no default dataset. Always present on the response — sourced via the centralized `RUN_SELECT_WITH_DATASET_COUNT` join in the API. Use this when integrating from the dashboard or custom tooling. |
| `defaultKeyValueStoreId`    | string \| null   | Default KV store for the run.                                                                                                                                                                                                                                                      |
| `defaultRequestQueueId`     | string \| null   | Default request queue for the run.                                                                                                                                                                                                                                                 |
| `options.timeoutSecs`       | number           | Effective timeout for this run.                                                                                                                                                                                                                                                    |
| `options.memoryMbytes`      | number           | Effective memory limit for this run.                                                                                                                                                                                                                                               |
| `stats`                     | object           | Crawlee SDK statistics ingested at run completion, plus the live dataset item count below for Apify-client compatibility.                                                                                                                                                          |
| `stats.datasetItemCount`    | number           | Same value as `defaultDatasetItemCount`, defaulted to `0` when there is no dataset. Mirrors Apify's nested location so `apify-client` consumers reading `run.stats.datasetItemCount` work unchanged.                                                                                |
| `exitCode`                  | number \| null   | Process exit code from the runner; null while the run is still in flight.                                                                                                                                                                                                          |
| `startedAt` / `finishedAt`  | ISO string       | Wall-clock timestamps; `finishedAt` is null until terminal.                                                                                                                                                                                                                        |
| `createdAt` / `modifiedAt`  | ISO string       | Row lifecycle timestamps.                                                                                                                                                                                                                                                          |

**Note on webhooks**: the webhook payload's `resource.stats` is built by the runner from the ingested Crawlee statistics blob and does NOT currently mirror `stats.datasetItemCount` — webhook receivers that need the dataset count should query `/v2/actor-runs/{id}` from the `resource.id` they receive. This is tracked for parity in v1.0.1.

---

## Response Format

All successful responses wrap data in a `data` field:

```json
{
  "data": {
    "id": "abc123",
    "name": "my-dataset",
    "itemCount": 42
  }
}
```

### Validation Errors

Invalid request bodies return a 400 with Zod validation details:

```json
{
  "error": {
    "type": "validation_error",
    "message": "Validation failed",
    "details": [{ "path": ["name"], "message": "String must contain at least 1 character(s)" }]
  }
}
```

### Error Responses

```json
{
  "error": {
    "type": "RECORD_NOT_FOUND",
    "message": "Dataset with ID 'xyz' was not found"
  }
}
```

| HTTP Code | Description                     |
| --------- | ------------------------------- |
| `400`     | Bad request / validation error  |
| `401`     | Authentication required         |
| `404`     | Resource not found              |
| `409`     | Conflict (e.g., locked request) |
| `500`     | Internal server error           |
