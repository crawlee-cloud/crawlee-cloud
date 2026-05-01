import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  runMigrations,
  createTestUser,
  cleanDatabase,
  ensureS3Bucket,
} from './setup.js';

describe('Key-Value Stores (integration)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
    const user = await createTestUser();
    token = user.token;
  });

  afterEach(async () => {
    await cleanDatabase();
    const user = await createTestUser();
    token = user.token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a store, sets a JSON value, and gets it back', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v2/key-value-stores',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'test-kv' },
    });
    expect(create.statusCode).toBe(201);
    const storeId = create.json().data.id;

    // Set value
    const put = await app.inject({
      method: 'PUT',
      url: `/v2/key-value-stores/${storeId}/records/OUTPUT`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ result: 'hello' }),
    });
    // Apify v2 returns 201 Created on PUT record
    expect(put.statusCode).toBe(201);

    // Get value
    const get = await app.inject({
      method: 'GET',
      url: `/v2/key-value-stores/${storeId}/records/OUTPUT`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ result: 'hello' });
  });

  /**
   * Locks the apify-client compat contract.
   *
   * apify-client's `catchNotFoundOrThrow` (utils.js) only swallows a 404
   * when `error.type === 'record-not-found'`. Without it, the SDK
   * re-throws and `KeyValueStore.open(<name>)` blows up instead of
   * falling through to `getOrCreate` — breaking the auto-create-on-open
   * pattern Apify cloud supports. See PR #15.
   */
  it("returns 404 with error.type='record-not-found' for a missing store", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/key-value-stores/nonexistent-store-xyz',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        type: 'record-not-found',
        message: 'Key-value store not found',
      },
    });
  });

  /**
   * Simulates @crawlee/core's StorageManager._getOrCreateStorage flow:
   *   1. GET /v2/key-value-stores/<name>           → 404 (must be swallowable)
   *   2. POST /v2/key-value-stores?name=<name>     → 201 (auto-create)
   *   3. GET /v2/key-value-stores/<name>           → 200 (now resolvable)
   *
   * Without the `type` field on step 1, apify-client re-throws and the
   * SDK never reaches step 2.
   */
  it('supports the open-by-name auto-create chain (KeyValueStore.open(<name>))', async () => {
    const name = 'autocreated-by-name-' + Date.now();

    const lookupBefore = await app.inject({
      method: 'GET',
      url: `/v2/key-value-stores/${name}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(lookupBefore.statusCode).toBe(404);
    expect(lookupBefore.json().error.type).toBe('record-not-found');

    const create = await app.inject({
      method: 'POST',
      url: `/v2/key-value-stores?name=${name}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().data.name).toBe(name);

    const lookupAfter = await app.inject({
      method: 'GET',
      url: `/v2/key-value-stores/${name}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(lookupAfter.statusCode).toBe(200);
    expect(lookupAfter.json().data.name).toBe(name);
  });

  it('handles binary data round-trip', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v2/key-value-stores',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'binary-kv' },
    });
    const storeId = create.json().data.id;

    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff]);

    await app.inject({
      method: 'PUT',
      url: `/v2/key-value-stores/${storeId}/records/BINARY`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      payload: binaryData,
    });

    const get = await app.inject({
      method: 'GET',
      url: `/v2/key-value-stores/${storeId}/records/BINARY`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(Buffer.from(get.rawPayload)).toEqual(binaryData);
  });
});
