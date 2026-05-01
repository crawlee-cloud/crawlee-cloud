/**
 * Apify-client compat round-trip (integration)
 *
 * Boots the Fastify app on a real HTTP port and points the official
 * `apify-client` library at it. This catches HTTP-layer compatibility drift
 * that `app.inject()`-based tests cannot — header casing, content-type
 * negotiation, body encoding, status-code semantics, JSON shape parsing,
 * and the SDK's "open or create" / "catchNotFoundOrThrow" fallback paths.
 *
 * The Apify-client memory note in this repo specifically calls out:
 *   - 404 responses must include `error.type === 'record-not-found'` for
 *     catchNotFoundOrThrow to fall through to getOrCreate (PR #15)
 *   - dataset items must be returned as a raw array (not wrapped)
 *
 * Both are exercised here against the real wire, not via inject().
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApifyClient } from 'apify-client';
import type { FastifyInstance } from 'fastify';
import { createTestApp, runMigrations, createTestUser, ensureS3Bucket } from './setup.js';

describe('apify-client round-trip (integration)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let client: ApifyClient;

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();

    // Real HTTP listener — apify-client uses fetch under the hood and won't
    // work via Fastify's inject() shim.
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address.replace(/\/$/, '');

    const { token } = await createTestUser('apify-compat@test.local', 'pw-apify-compat-1');
    // ApifyClient internally appends /v2 to baseUrl (see apify_client.js),
    // so we pass the bare server URL — NOT `${baseUrl}/v2`.
    client = new ApifyClient({ token, baseUrl });
  });

  afterAll(async () => {
    await app.close();
  });

  it('round-trips dataset items as a raw array', async () => {
    // getOrCreate exercises the 404→create fallback, which depends on the
    // server returning error.type='record-not-found' on 404.
    const ds = await client.datasets().getOrCreate('compat-ds');
    expect(ds.id).toBeTruthy();

    await client.dataset(ds.id).pushItems([{ n: 1 }, { n: 2 }, { n: 3 }]);

    const list = await client.dataset(ds.id).listItems();
    expect(list.items).toHaveLength(3);
    expect(list.items[0]).toMatchObject({ n: 1 });
  });

  it('round-trips a JSON value through the key-value store', async () => {
    const kv = await client.keyValueStores().getOrCreate('compat-kv');
    expect(kv.id).toBeTruthy();

    await client.keyValueStore(kv.id).setRecord({
      key: 'OUTPUT',
      value: { result: 'ok', count: 7 },
    });

    const record = await client.keyValueStore(kv.id).getRecord('OUTPUT');
    expect(record?.value).toEqual({ result: 'ok', count: 7 });
  });

  it('returns falsy (not throw, not stub object) for a missing KV record via the SDK', async () => {
    // Apify SDK contract (apify-client v2.23.x):
    //   getRecord(key) tries the GET, then on the response:
    //     - 200 with body          → { key, value, contentType }
    //     - 404 + error.type='record-not-found' → catchNotFoundOrThrow → undefined
    //     - anything else (incl. 204) → returned as-is, with value = undefined
    //
    // The route currently returns 204 ("Apify SDK compatibility" per the
    // route comment), which the SDK treats as a *successful empty response*
    // and yields { key, value: undefined, contentType: undefined } —
    // truthy, not falsy. That's a bug: same family as the apify_404_type_field
    // memo (PR #15). Fix is to return 404 + error.type='record-not-found'
    // from key-value-stores.ts:177-180 instead of 204.
    const kv = await client.keyValueStores().getOrCreate('compat-kv-missing');
    const missing = await client.keyValueStore(kv.id).getRecord('NOT_HERE');
    expect(missing).toBeFalsy();
  });

  it('round-trips request-queue add and getOrCreate', async () => {
    const rq = await client.requestQueues().getOrCreate('compat-rq');
    expect(rq.id).toBeTruthy();

    const added = await client.requestQueue(rq.id).addRequest({
      url: 'https://example.com/compat',
      uniqueKey: 'compat-1',
    });
    expect(added.requestId).toBeTruthy();
    expect(added.wasAlreadyPresent).toBe(false);

    // Adding the same uniqueKey again returns wasAlreadyPresent=true with the
    // same requestId — the dedup contract Crawlee/Apify SDK relies on.
    const dup = await client.requestQueue(rq.id).addRequest({
      url: 'https://example.com/compat',
      uniqueKey: 'compat-1',
    });
    expect(dup.wasAlreadyPresent).toBe(true);
    expect(dup.requestId).toBe(added.requestId);
  });

  it('treats getOrCreate as idempotent on repeat calls', async () => {
    // The whole point of the apify_404_type_field memo: this call must work
    // twice without error. First call goes 404→create→201. Second call goes
    // 200 (resource now exists). If 404 didn't expose error.type, the SDK
    // would throw on the first call instead of falling through.
    const a = await client.datasets().getOrCreate('idempotent-ds');
    const b = await client.datasets().getOrCreate('idempotent-ds');
    expect(a.id).toBe(b.id);
  });
});
