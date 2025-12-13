# API Reference

The Crawlee Cloud API is fully compatible with the Apify API v2.

## Base URL

```
https://your-server.com/v2
```

## Authentication

All API requests require a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://your-server.com/v2/datasets
```

## Endpoints

### Datasets

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v2/datasets` | List all datasets |
| `POST` | `/v2/datasets` | Create a dataset |
| `GET` | `/v2/datasets/{id}` | Get dataset info |
| `DELETE` | `/v2/datasets/{id}` | Delete a dataset |
| `POST` | `/v2/datasets/{id}/items` | Push items |
| `GET` | `/v2/datasets/{id}/items` | Get items |

### Key-Value Stores

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v2/key-value-stores` | List all stores |
| `POST` | `/v2/key-value-stores` | Create a store |
| `GET` | `/v2/key-value-stores/{id}` | Get store info |
| `PUT` | `/v2/key-value-stores/{id}/records/{key}` | Set a record |
| `GET` | `/v2/key-value-stores/{id}/records/{key}` | Get a record |
| `DELETE` | `/v2/key-value-stores/{id}/records/{key}` | Delete a record |

### Request Queues

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v2/request-queues` | List all queues |
| `POST` | `/v2/request-queues` | Create a queue |
| `POST` | `/v2/request-queues/{id}/requests` | Add requests |
| `POST` | `/v2/request-queues/{id}/head/lock` | Lock and get requests |
| `DELETE` | `/v2/request-queues/{id}/requests/{requestId}/lock` | Unlock a request |

### Actors

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v2/acts` | List all actors |
| `POST` | `/v2/acts` | Create an actor |
| `GET` | `/v2/acts/{id}` | Get actor info |
| `POST` | `/v2/acts/{id}/runs` | Start a run |

### Runs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v2/actor-runs` | List all runs |
| `GET` | `/v2/actor-runs/{id}` | Get run status |
| `POST` | `/v2/actor-runs/{id}/abort` | Abort a run |

## Response Format

All responses follow the Apify API format:

```json
{
  "data": { ... }
}
```

## Error Handling

Errors return standard HTTP status codes with a message:

```json
{
  "error": {
    "type": "RECORD_NOT_FOUND",
    "message": "Dataset not found"
  }
}
```
