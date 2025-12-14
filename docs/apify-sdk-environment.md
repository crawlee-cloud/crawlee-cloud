# Apify SDK Environment

Crawlee Cloud is fully compatible with the Apify SDK. Your existing Actors work with minimal configuration.

## How It Works

The Apify SDK reads the `APIFY_API_BASE_URL` environment variable to determine where to send API requests. By pointing this to your Crawlee Cloud server, all SDK calls are routed to your infrastructure.

## Configuration

### For Actor Development

Set these environment variables:

```bash
export APIFY_API_BASE_URL=https://your-server.com/v2
export APIFY_TOKEN=your-api-token
```

### In Your Actor Code

No code changes needed! The SDK uses environment variables automatically:

```typescript
import { Actor } from 'apify';

await Actor.init();

// All these work with Crawlee Cloud:
await Actor.pushData({ title: 'Example' });
const input = await Actor.getInput();
await Actor.setValue('OUTPUT', results);

await Actor.exit();
```

## Supported SDK Features

| Feature | Status |
|---------|--------|
| `Actor.init()` / `Actor.exit()` | ✅ |
| `Actor.pushData()` | ✅ |
| `Actor.getInput()` | ✅ |
| `Actor.getValue()` / `Actor.setValue()` | ✅ |
| `Actor.openDataset()` | ✅ |
| `Actor.openKeyValueStore()` | ✅ |
| `Actor.openRequestQueue()` | ✅ |
| Request Queue deduplication | ✅ |
| Distributed locking | ✅ |

## Running Locally

Test your Actor against Crawlee Cloud:

```bash
APIFY_API_BASE_URL=http://localhost:3000/v2 \
APIFY_TOKEN=your-token \
npm start
```

## Pushing to Crawlee Cloud

```bash
# Login first
crawlee-cloud login --server https://your-server.com

# Push your Actor
crawlee-cloud push my-actor
```

## Differences from Apify Platform

- Self-hosted: You control the infrastructure
- No usage limits: Run as many Actors as your hardware allows
- Private: Data never leaves your servers
- Open source: Customize as needed
