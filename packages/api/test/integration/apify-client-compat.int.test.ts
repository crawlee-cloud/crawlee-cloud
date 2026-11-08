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
  let token: string;

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();

    // Real HTTP listener — apify-client uses fetch under the hood and won't
    // work via Fastify's inject() shim.
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address.replace(/\/$/, '');

    ({ token } = await createTestUser('apify-compat@test.local', 'pw-apify-compat-1'));
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

  it('lists runs ascending with desc: false (sent as desc=0)', async () => {
    // apify-client serializes booleans as 1/0; desc=0 used to be a 400.
    const actor = await client.actors().create({ name: 'compat-runs-actor' });
    const r1 = await client.actor(actor.id).start();
    const r2 = await client.actor(actor.id).start();

    const asc = await client.runs().list({ desc: false });
    expect(asc.items.map((r) => r.id)).toEqual([r1.id, r2.id]);
    const desc = await client.runs().list({ desc: true });
    expect(desc.items.map((r) => r.id)).toEqual([r2.id, r1.id]);
    const multi = await client.runs().list({ status: ['READY', 'FAILED'], desc: false });
    expect(multi.items.map((r) => r.id)).toEqual([r1.id, r2.id]);

    // apify-client >= 2.23.4 calls /actors/:id/runs (alias pending, #109),
    // so the per-actor list is exercised over raw fetch on /acts.
    const res = await fetch(`${baseUrl}/v2/acts/compat-runs-actor/runs?desc=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { total: number; items: Array<{ id: string }> } };
    expect(body.data.total).toBe(2);
    expect(body.data.items.map((r) => r.id)).toEqual([r1.id, r2.id]);
  });

  it('puts a forefront request at the head of the queue (sent as forefront=1)', async () => {
    const rq = await client.requestQueues().getOrCreate('compat-rq-forefront');
    const queue = client.requestQueue(rq.id);
    await queue.addRequest({ url: 'https://example.com/a', uniqueKey: 'a' });
    await queue.addRequest({ url: 'https://example.com/b', uniqueKey: 'b' });
    await queue.addRequest(
      { url: 'https://example.com/front', uniqueKey: 'front' },
      { forefront: true }
    );
    await queue.addRequest(
      { url: 'https://example.com/front2', uniqueKey: 'front2' },
      { forefront: true }
    );

    // LIFO among forefront requests: the latest one is served first.
    const head = await queue.listHead();
    expect(head.items.map((r) => r.uniqueKey)).toEqual(['front2', 'front', 'a', 'b']);
  });

  it('honours forefront on batch add, reclaim (PUT) and lock release', async () => {
    const rq = await client.requestQueues().getOrCreate('compat-rq-forefront-routes');
    const queue = client.requestQueue(rq.id);
    await queue.addRequest({ url: 'https://example.com/a', uniqueKey: 'a' });
    await queue.addRequest({ url: 'https://example.com/b', uniqueKey: 'b' });

    // Batch: both forefront rows land ahead of the tail. Order within the
    // batch is not asserted (chunk elements insert concurrently).
    await queue.batchAddRequests(
      [
        { url: 'https://example.com/x', uniqueKey: 'x' },
        { url: 'https://example.com/y', uniqueKey: 'y' },
      ],
      { forefront: true }
    );
    let head = await queue.listHead();
    expect(
      head.items
        .map((r) => r.uniqueKey)
        .slice(0, 2)
        .sort()
    ).toEqual(['x', 'y']);
    expect(head.items.map((r) => r.uniqueKey).slice(2)).toEqual(['a', 'b']);

    // Reclaim via PUT with forefront moves 'b' to the head.
    const b = head.items.find((r) => r.uniqueKey === 'b');
    const full = await queue.getRequest(b.id);
    await queue.updateRequest(full, { forefront: true });
    head = await queue.listHead();
    expect(head.items[0].uniqueKey).toBe('b');

    // Lock release with forefront moves 'a' to the head.
    const a = head.items.find((r) => r.uniqueKey === 'a');
    await queue.deleteRequestLock(a.id, { forefront: true });
    head = await queue.listHead();
    expect(head.items[0].uniqueKey).toBe('a');

    // POST /head/lock serves the same order as GET /head.
    const locked = await queue.listAndLockHead({ lockSecs: 60, limit: 10 });
    expect(locked.items.map((r) => r.uniqueKey)).toEqual(head.items.map((r) => r.uniqueKey));
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

  describe('actors via /v2/actors (apify-client >= 2.23.4)', () => {
    let actorId: string;

    beforeAll(async () => {
      const actor = await client.actors().create({ name: 'compat-actor', title: 'Compat' });
      actorId = actor.id;
    });

    it('client.actor(id).get() resolves the actor', async () => {
      const actor = await client.actor(actorId).get();
      expect(actor?.id).toBe(actorId);
      expect(actor?.name).toBe('compat-actor');
    });

    it('client.actor(id).get() returns undefined for a missing actor', async () => {
      // record-not-found from the handler → catchNotFoundOrThrow → undefined.
      expect(await client.actor('no-such-actor').get()).toBeUndefined();
    });

    it('client.actors().list() lists the actor', async () => {
      const list = await client.actors().list();
      expect(list.total).toBeGreaterThanOrEqual(1);
      expect(list.items.map((a) => a.id)).toContain(actorId);
    });

    it('client.actor(id).update() accepts a compressed body over 1 KB', async () => {
      // apify-client 2.25 brotli-compresses bodies >= 1 KB (2.23 used gzip).
      const description = 'x'.repeat(2048);
      const updated = await client.actor(actorId).update({ description });
      expect(updated.description).toBe(description);

      const fetched = await client.actor(actorId).get();
      expect(fetched?.description).toBe(description);
    });

    it('defaultBuild().get() returns the pushed actorDefinition (#117)', async () => {
      const input = { title: 'Input', type: 'object', schemaVersion: 1, properties: {} };
      const actor = await client.actors().create({
        name: 'compat-default-build',
        defaultRunOptions: { image: 'ghcr.io/acme/compat-default-build:1' },
        version: '0.1',
        actorDefinition: { actorSpecification: 1, name: 'compat-default-build', input },
      } as Parameters<ReturnType<ApifyClient['actors']>['create']>[0]);

      const build = await (await client.actor(actor.id).defaultBuild()).get();
      expect(build?.status).toBe('SUCCEEDED');
      expect(build?.actorDefinition?.input).toEqual(input);
    });

    it('unknown routes return the platform envelope with page-not-found', async () => {
      const res = await fetch(`${baseUrl}/v2/no-such-route`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('page-not-found');
      expect(body.error.message).toBe('Route GET /v2/no-such-route not found');
    });
  });
  describe('run start body contract (#115)', () => {
    let actorId: string;
    const auth = () => ({ authorization: `Bearer ${token}` });

    const getInput = async (kvStoreId: string) =>
      (await client.keyValueStore(kvStoreId).getRecord('INPUT'))?.value;

    beforeAll(async () => {
      const actor = await client.actors().create({ name: 'compat-run-body' });
      actorId = actor.id;
    });

    it('client.actor(id).start(input) stores the input as INPUT', async () => {
      const run = await client.actor(actorId).start({ query: 'x' }, { memory: 512, timeout: 60 });
      expect(await getInput(run.defaultKeyValueStoreId)).toEqual({ query: 'x' });

      const fetched = await client.run(run.id).get();
      expect(fetched?.options).toMatchObject({ timeoutSecs: 60, memoryMbytes: 512 });
    });

    it('raw Apify body with ?timeout&memory sets timeout_secs/memory_mbytes', async () => {
      const res = await fetch(`${baseUrl}/v2/acts/${actorId}/runs?timeout=60&memory=512`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'x' }),
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as {
        data: { id: string; defaultKeyValueStoreId: string };
      };
      expect(await getInput(data.defaultKeyValueStoreId)).toEqual({ query: 'x' });

      const { query } = await import('../../src/db/index.js');
      const row = await query<{ timeout_secs: number; memory_mbytes: number }>(
        'SELECT timeout_secs, memory_mbytes FROM runs WHERE id = $1',
        [data.id]
      );
      expect(row.rows[0]).toEqual({ timeout_secs: 60, memory_mbytes: 512 });
    });

    it('envVars in an Apify body are input; ?envVars=<base64> sets env vars', async () => {
      const { redis } = await import('../../src/storage/redis.js');

      const inBody = await client.actor(actorId).start({ query: 'x', envVars: { A: '1' } });
      expect(await redis.get(`run:${inBody.id}:envVars`)).toBeNull();
      expect(await getInput(inBody.defaultKeyValueStoreId)).toEqual({
        query: 'x',
        envVars: { A: '1' },
      });

      const envVars = Buffer.from(JSON.stringify({ A: '1' })).toString('base64');
      const res = await fetch(
        `${baseUrl}/v2/acts/${actorId}/runs?envVars=${encodeURIComponent(envVars)}`,
        {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'x' }),
        }
      );
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { id: string } };
      expect(await redis.get(`run:${data.id}:envVars`)).toBe(JSON.stringify({ A: '1' }));
    });

    it('dashboard body {timeout, memory} still applies them with input {}', async () => {
      const res = await fetch(`${baseUrl}/v2/acts/${actorId}/runs`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ timeout: 3600, memory: 1024 }),
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as {
        data: { id: string; defaultKeyValueStoreId: string };
      };
      expect(await getInput(data.defaultKeyValueStoreId)).toEqual({});
      const run = await client.run(data.id).get();
      expect(run?.options).toMatchObject({ timeoutSecs: 3600, memoryMbytes: 1024 });
    });

    it('legacy CLI body {input, envVars} still works', async () => {
      const { redis } = await import('../../src/storage/redis.js');
      const res = await fetch(`${baseUrl}/v2/acts/${actorId}/runs`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ input: { query: 'legacy' }, envVars: { B: '2' }, memory: 256 }),
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as {
        data: { id: string; defaultKeyValueStoreId: string };
      };
      expect(await getInput(data.defaultKeyValueStoreId)).toEqual({ query: 'legacy' });
      expect(await redis.get(`run:${data.id}:envVars`)).toBe(JSON.stringify({ B: '2' }));
    });

    it('run-sync forwards an Apify body and ?memory', async () => {
      const res = await fetch(`${baseUrl}/v2/actors/compat-run-body/run-sync?memory=512`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'sync' }),
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as {
        data: { id: string; defaultKeyValueStoreId: string };
      };
      expect(await getInput(data.defaultKeyValueStoreId)).toEqual({ query: 'sync' });
      const run = await client.run(data.id).get();
      expect(run?.options).toMatchObject({ memoryMbytes: 512 });
    });

    describe('run-sync over the wire', () => {
      let apiKey: string;

      beforeAll(async () => {
        const { createHash } = await import('node:crypto');
        const { nanoid } = await import('nanoid');
        const { pool } = await import('../../src/db/index.js');
        const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
          'apify-compat@test.local',
        ]);
        const userId = rows[0]!.id;
        apiKey = `cp_${nanoid(32)}`;
        await pool.query(
          `INSERT INTO api_keys (id, user_id, name, key_hash, key_sha256)
           VALUES ($1, $2, 'run-sync-test', 'unused', $3)`,
          [nanoid(), userId, createHash('sha256').update(apiKey).digest('hex')]
        );
      });

      const runSync = async (
        init: { contentType?: string; body?: string },
        authMode: 'bearer' | 'query' = 'bearer'
      ) => {
        const qs = authMode === 'query' ? `?token=${encodeURIComponent(apiKey)}` : '';
        const headers: Record<string, string> = {};
        if (authMode === 'bearer') headers.authorization = `Bearer ${apiKey}`;
        if (init.contentType) headers['content-type'] = init.contentType;
        return fetch(`${baseUrl}/v2/acts/compat-run-body/run-sync${qs}`, {
          method: 'POST',
          headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
        });
      };

      const inputOf = async (res: Response) => {
        expect(res.status).toBe(201);
        const { data } = (await res.json()) as { data: { defaultKeyValueStoreId: string } };
        return getInput(data.defaultKeyValueStoreId);
      };

      it('empty form-urlencoded body stores INPUT as the object {}', async () => {
        const input = await inputOf(
          await runSync({ contentType: 'application/x-www-form-urlencoded', body: '' })
        );
        expect(input).toEqual({});
        expect(typeof input).toBe('object');
      });

      it('JSON body stores INPUT as the object', async () => {
        const input = await inputOf(
          await runSync({ contentType: 'application/json', body: '{"query":"sync-json"}' })
        );
        expect(input).toEqual({ query: 'sync-json' });
      });

      it('authenticates with an API key as Bearer and as ?token=', async () => {
        const body = { contentType: 'application/json', body: '{"query":"auth"}' };
        expect(await inputOf(await runSync(body, 'bearer'))).toEqual({ query: 'auth' });
        expect(await inputOf(await runSync(body, 'query'))).toEqual({ query: 'auth' });

        const unauth = await fetch(`${baseUrl}/v2/acts/compat-run-body/run-sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(unauth.status).toBe(401);
      });
    });

    it('non-empty form-urlencoded body (curl -d) is a 415 with a JSON hint, no run', async () => {
      const before = await client.actor(actorId).runs().list();
      for (const path of ['runs', 'run-sync']) {
        const res = await fetch(`${baseUrl}/v2/acts/${actorId}/${path}`, {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/x-www-form-urlencoded' },
          body: '{"query":"x"}',
        });
        expect(res.status).toBe(415);
        const { error } = (await res.json()) as { error: { type: string; message: string } };
        expect(error.type).toBe('unsupported-media-type');
        expect(error.message).toContain('Content-Type: application/json');
      }
      const after = await client.actor(actorId).runs().list();
      expect(after.total).toBe(before.total);
    });

    it('legacy wrapper body takes ?timeout&memory when it lacks them', async () => {
      const res = await fetch(`${baseUrl}/v2/acts/${actorId}/runs?timeout=60&memory=512`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ input: { query: 'legacy-q' } }),
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as {
        data: { id: string; defaultKeyValueStoreId: string };
      };
      expect(await getInput(data.defaultKeyValueStoreId)).toEqual({ query: 'legacy-q' });
      const run = await client.run(data.id).get();
      expect(run?.options).toMatchObject({ timeoutSecs: 60, memoryMbytes: 512 });

      const conflict = await fetch(`${baseUrl}/v2/acts/${actorId}/runs?memory=512`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ input: {}, memory: 256 }),
      });
      const { data: d2 } = (await conflict.json()) as { data: { id: string } };
      expect((await client.run(d2.id).get())?.options).toMatchObject({ memoryMbytes: 256 });
    });

    it('rejects text/plain with 415; text/plain KV records still upload', async () => {
      const res = await fetch(`${baseUrl}/v2/acts/${actorId}/runs`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'text/plain' },
        body: 'hello',
      });
      expect(res.status).toBe(415);

      const kv = await client.keyValueStores().getOrCreate('compat-run-body-kv');
      await client
        .keyValueStore(kv.id)
        .setRecord({ key: 'NOTE', value: 'plain text', contentType: 'text/plain' });
      const record = await client.keyValueStore(kv.id).getRecord('NOTE');
      expect(record?.value).toBe('plain text');
    });

    it('?waitForFinish returns the run once it is terminal', async () => {
      // No runner in the integration stack: finish the run ~1 s after the
      // start request was sent, while the start request is still waiting.
      const started = Date.now();
      const startPromise = client.actor(actorId).start({ query: 'wait' }, { waitForFinish: 30 });

      let runId: string | undefined;
      while (!runId && Date.now() - started < 10_000) {
        await new Promise((r) => setTimeout(r, 200));
        const list = await client.actor(actorId).runs().list({ desc: true, limit: 1 });
        const latest = list.items[0];
        if (latest && latest.status === 'READY') {
          const input = await getInput(latest.defaultKeyValueStoreId);
          if ((input as { query?: string } | undefined)?.query === 'wait') runId = latest.id;
        }
      }
      expect(runId).toBeDefined();

      const put = await fetch(`${baseUrl}/v2/actor-runs/${runId}`, {
        method: 'PUT',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'SUCCEEDED' }),
      });
      expect(put.status).toBe(200);

      const run = await startPromise;
      expect(run.id).toBe(runId);
      expect(run.status).toBe('SUCCEEDED');
      expect(Date.now() - started).toBeLessThan(30_000);
    });
  });
});
