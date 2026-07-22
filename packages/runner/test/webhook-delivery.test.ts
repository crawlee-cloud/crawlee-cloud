/**
 * Tests for webhook delivery (queue.ts): triggerWebhooks fan-out and
 * attemptWebhookDelivery outcomes. The pg pool is a plain fake passed
 * through the DI parameters; the network is a stubbed global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';
import { attemptWebhookDelivery, triggerWebhooks, type RunJob } from '../src/queue.js';

function mockPool(...results: { rows: unknown[] }[]) {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  query.mockResolvedValue({ rows: [] });
  return { query } as unknown as pg.Pool & { query: ReturnType<typeof vi.fn> };
}

const RUN: RunJob = {
  id: 'run-1',
  actor_id: 'actor-1',
  user_id: 'user-1',
  status: 'SUCCEEDED',
  default_dataset_id: 'ds-1',
  default_key_value_store_id: 'kv-1',
  default_request_queue_id: 'rq-1',
  timeout_secs: 300,
  memory_mbytes: 1024,
  retry_count: 0,
  origin_run_id: null,
  run_after: null,
  started_at: new Date('2026-07-21T10:00:00Z'),
  finished_at: new Date('2026-07-21T10:05:00Z'),
  exit_code: 0,
};

const WEBHOOK = {
  id: 'wh-1',
  request_url: 'https://hooks.example.com/receive',
  payload_template: null,
  headers: null,
};

function stubFetch(response: { ok: boolean; status: number; body?: string }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    text: () => Promise.resolve(response.body ?? ''),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('attemptWebhookDelivery', () => {
  it('marks the delivery DELIVERED on a 2xx response', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: 'received' });
    const db = mockPool();

    await attemptWebhookDelivery('dlv-1', WEBHOOK, RUN, 'ACTOR.RUN.SUCCEEDED', db);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK.request_url);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const sent = JSON.parse(init.body as string) as {
      eventType: string;
      resource: { id: string; status: string; exitCode: number };
    };
    expect(sent.eventType).toBe('ACTOR.RUN.SUCCEEDED');
    expect(sent.resource.id).toBe('run-1');
    expect(sent.resource.status).toBe('SUCCEEDED');
    expect(sent.resource.exitCode).toBe(0);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'DELIVERED'");
    expect(params[1]).toBe(200);
    expect(params[2]).toBe('received');
    expect(params[3]).toBe('dlv-1');
  });

  it('merges custom webhook headers into the request', async () => {
    const fetchMock = stubFetch({ ok: true, status: 204 });
    const db = mockPool();

    await attemptWebhookDelivery(
      'dlv-1',
      { ...WEBHOOK, headers: { 'X-Auth': 'secret-header' } },
      RUN,
      'ACTOR.RUN.SUCCEEDED',
      db
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Auth']).toBe('secret-header');
  });

  it('applies the payload template with typed splicing', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });
    const db = mockPool();

    await attemptWebhookDelivery(
      'dlv-1',
      { ...WEBHOOK, payload_template: '{"evt": "{{eventType}}", "data": "{{eventData}}"}' },
      RUN,
      'ACTOR.RUN.FAILED',
      db
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as {
      evt: string;
      data: { actorId: string; actorRunId: string };
    };
    expect(sent.evt).toBe('ACTOR.RUN.FAILED');
    // "{{eventData}}" splices the object itself, not its stringification.
    expect(sent.data).toEqual({ actorId: 'actor-1', actorRunId: 'run-1' });
  });

  it('schedules a retry with the first backoff delay on an HTTP error', async () => {
    stubFetch({ ok: false, status: 503, body: 'unavailable' });
    // scheduleRetry: SELECT attempt_count, then UPDATE with next_retry_at.
    const db = mockPool({ rows: [{ attempt_count: 0, max_attempts: 5 }] });

    await attemptWebhookDelivery('dlv-1', WEBHOOK, RUN, 'ACTOR.RUN.SUCCEEDED', db);

    expect(db.query).toHaveBeenCalledTimes(2);
    const [sql, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('next_retry_at = NOW()');
    // [newAttempt, requestBody, responseStatus, responseBody, delaySecs, id]
    expect(params[0]).toBe(1);
    expect(params[2]).toBe(503);
    expect(params[3]).toBe('unavailable');
    expect(params[4]).toBe(10); // first rung of the backoff ladder
    expect(params[5]).toBe('dlv-1');
  });

  it('schedules a retry with a null status when fetch itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const db = mockPool({ rows: [{ attempt_count: 0, max_attempts: 5 }] });

    await attemptWebhookDelivery('dlv-1', WEBHOOK, RUN, 'ACTOR.RUN.SUCCEEDED', db);

    const [, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(params[2]).toBeNull();
    expect(params[3]).toBe('ECONNRESET');
    // The body was rendered before fetch threw, so the stored copy is real.
    expect(typeof params[1]).toBe('string');
  });

  it('fails immediately without fetching when the URL targets a private address', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });
    const db = mockPool();

    await attemptWebhookDelivery(
      'dlv-1',
      { ...WEBHOOK, request_url: 'http://169.254.169.254/latest' },
      RUN,
      'ACTOR.RUN.SUCCEEDED',
      db
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'FAILED'");
    expect(sql).toContain('private/internal network address');
    expect(params[1]).toBe('dlv-1');
  });

  it('redacts secret-bearing template output in the stored request body only', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });
    const db = mockPool();

    await attemptWebhookDelivery(
      'dlv-1',
      { ...WEBHOOK, payload_template: '{"apiToken": "rendered-secret-value-123"}' },
      RUN,
      'ACTOR.RUN.SUCCEEDED',
      db
    );

    // Receiver gets the raw secret…
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body as string).toContain('rendered-secret-value-123');
    // …while the persisted copy is masked.
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toContain('••• -123');
    expect(params[0]).not.toContain('rendered-secret-value-123');
  });
});

describe('triggerWebhooks', () => {
  it('translates hyphenated statuses to underscore event types and delivers', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });
    const db = mockPool(
      { rows: [RUN] }, // run lookup
      { rows: [WEBHOOK] }, // matching webhooks
      { rows: [] } // delivery INSERT
    );

    await triggerWebhooks('run-1', 'TIMED-OUT', db);

    const [insertSql, insertParams] = db.query.mock.calls[2] as [string, unknown[]];
    expect(insertSql).toContain('INSERT INTO webhook_deliveries');
    expect(insertParams[3]).toBe('ACTOR.RUN.TIMED_OUT');
    // The webhook-match query filters on the translated event type.
    const [, matchParams] = db.query.mock.calls[1] as [string, unknown[]];
    expect(matchParams[0]).toBe('ACTOR.RUN.TIMED_OUT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the run row is gone', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });
    const db = mockPool({ rows: [] });

    await triggerWebhooks('run-missing', 'SUCCEEDED', db);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when no webhooks match', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });
    const db = mockPool({ rows: [RUN] }, { rows: [] });

    await triggerWebhooks('run-1', 'SUCCEEDED', db);

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
