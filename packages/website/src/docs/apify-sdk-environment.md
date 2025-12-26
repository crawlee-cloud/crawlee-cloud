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

## Supported Features

| Feature                                 | Status |
| --------------------------------------- | ------ |
| `Actor.init()` / `Actor.exit()`         | ✅     |
| `Actor.pushData()`                      | ✅     |
| `Actor.getInput()`                      | ✅     |
| `Actor.getValue()` / `Actor.setValue()` | ✅     |
| `Actor.openDataset()`                   | ✅     |
| `Actor.openKeyValueStore()`             | ✅     |
| `Actor.openRequestQueue()`              | ✅     |
| Request deduplication                   | ✅     |
| Distributed locking                     | ✅     |

---

## Local Testing

Test your Actor against your Crawlee Cloud instance:

```bash
APIFY_API_BASE_URL=http://localhost:3000/v2 \
APIFY_TOKEN=your-token \
npm start
```

---

## Pushing Actors

```bash
# Login to your server
crawlee-cloud login --server https://your-server.com

# Push your Actor
crawlee-cloud push my-actor
```

---

## Choose Your Setup

| Aspect  | Hosted (Apify)  | Self-Hosted (Crawlee Cloud) |
| ------- | --------------- | --------------------------- |
| Hosting | Managed for you | Your own servers            |
| Billing | Usage-based     | Your infrastructure         |
| Data    | Cloud storage   | Self-managed storage         |
| Scale   | Plan tiers      | Configure as needed          |
| Source  | Commercial      | Open source                  |
