/**
 * Tests for buildActorEnv (docker.ts) — the Apify-compatible environment
 * a run's container receives. Pure given its options aside from
 * Date.now() (pinned with fake timers) and config defaults.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildActorEnv } from '../src/docker.js';

const BASE = {
  runId: 'run-1',
  actorId: 'actor-1',
  apiBaseUrl: 'https://api.example.com',
  token: 'tok',
  defaultDatasetId: 'ds-1',
  defaultKeyValueStoreId: 'kv-1',
  defaultRequestQueueId: 'rq-1',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('buildActorEnv', () => {
  it('builds the core Apify identity, connection, and storage variables', () => {
    const env = buildActorEnv({ ...BASE, userId: 'user-9' });

    expect(env.APIFY_ACTOR_ID).toBe('actor-1');
    expect(env.APIFY_ACTOR_RUN_ID).toBe('run-1');
    expect(env.APIFY_USER_ID).toBe('user-9');
    expect(env.APIFY_TOKEN).toBe('tok');
    expect(env.APIFY_DEFAULT_DATASET_ID).toBe('ds-1');
    expect(env.APIFY_DEFAULT_KEY_VALUE_STORE_ID).toBe('kv-1');
    expect(env.APIFY_DEFAULT_REQUEST_QUEUE_ID).toBe('rq-1');
    expect(env.APIFY_IS_AT_HOME).toBe('1');
    expect(env.APIFY_HEADLESS).toBe('1');
    expect(env.APIFY_INPUT_KEY).toBe('INPUT');
    expect(env.APIFY_CONTAINER_PORT).toBe('4321');
    expect(env.APIFY_CONTAINER_URL).toBe('http://run-run-1:4321');
    expect(env.CRAWLEE_STORAGE_DIR).toBe('/tmp/storage');
    // Both base-URL variables must carry the same (translated) value.
    expect(env.APIFY_API_BASE_URL).toBe(env.APIFY_API_PUBLIC_BASE_URL);
  });

  it('defaults the user to anonymous when none is given', () => {
    expect(buildActorEnv(BASE).APIFY_USER_ID).toBe('anonymous');
  });

  it('pins APIFY_TIMEOUT_AT to now + timeoutSecs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
    const env = buildActorEnv({ ...BASE, timeoutSecs: 600 });
    expect(env.APIFY_TIMEOUT_AT).toBe('2026-07-21T12:10:00.000Z');
  });

  it('falls back to config defaults for memory and timeout', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
    const env = buildActorEnv(BASE);
    // DEFAULT_MEMORY_MB / DEFAULT_TIMEOUT_SECS config defaults.
    expect(env.APIFY_MEMORY_MBYTES).toBe('1024');
    expect(env.APIFY_TIMEOUT_AT).toBe('2026-07-21T13:00:00.000Z');
  });

  it('uses explicit memory when provided', () => {
    expect(buildActorEnv({ ...BASE, memoryMbytes: 4096 }).APIFY_MEMORY_MBYTES).toBe('4096');
  });

  it('injects proxy variables only when values are truthy', () => {
    const withProxy = buildActorEnv({
      ...BASE,
      proxyPassword: 'pw-123',
      proxyHostname: 'proxy.local',
      proxyPort: 8000,
    });
    expect(withProxy.APIFY_PROXY_PASSWORD).toBe('pw-123');
    expect(withProxy.APIFY_PROXY_HOSTNAME).toBe('proxy.local');
    expect(withProxy.APIFY_PROXY_PORT).toBe('8000');

    // Absent/null/empty must NOT set the variables: an empty value routes
    // the SDK down the present-path with a bad credential (confusing 401s),
    // while an absent variable activates its well-tested API fallback.
    const withoutProxy = buildActorEnv({
      ...BASE,
      proxyPassword: '',
      proxyHostname: null,
    });
    expect(withoutProxy).not.toHaveProperty('APIFY_PROXY_PASSWORD');
    expect(withoutProxy).not.toHaveProperty('APIFY_PROXY_HOSTNAME');
    expect(withoutProxy).not.toHaveProperty('APIFY_PROXY_PORT');
  });
});
