/**
 * Unit tests for the run-start helper (#118): both request shapes, the
 * `/health` version gate with its fallbacks, the per-process cache and the
 * CRAWLEE_CLOUD_RUN_BODY override. `fetch` is stubbed; nothing hits the
 * network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MIN_APIFY_RUN_BODY_VERSION,
  RUN_BODY_ENV,
  getRunBodyShape,
  resetApiCapabilitiesCache,
  supportsApifyRunBody,
} from '../src/utils/api-capabilities.js';
import { buildStartRunRequest, startRun } from '../src/utils/runs.js';

const config = { apiBaseUrl: 'http://api.test', token: 'tok' };
const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/** Routes `/health` to `health` and run starts to a 201 with a run. */
function mockApi(health: () => unknown) {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/health')) return Promise.resolve(health());
    return Promise.resolve(jsonResponse({ data: { id: 'run-1', status: 'READY' } }, 201));
  });
}

function runCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.find(([url]) => !(url as string).endsWith('/health'));
  return call as [string, RequestInit];
}

const savedOverride = process.env[RUN_BODY_ENV];

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  resetApiCapabilitiesCache();
  delete process.env[RUN_BODY_ENV];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedOverride === undefined) delete process.env[RUN_BODY_ENV];
  else process.env[RUN_BODY_ENV] = savedOverride;
});

describe('supportsApifyRunBody', () => {
  it.each([
    [MIN_APIFY_RUN_BODY_VERSION, true],
    ['1.7.0', true],
    ['v1.7.0', true],
    ['1.7.1', true],
    ['1.10.0', true],
    ['2.0.0', true],
    ['1.7.0+build.5', true],
    // Prereleases of the gate version are cut after #115.
    ['1.7.0-rc.1', true],
    ['1.7.0-0', true],
    ['1.8.0-alpha', true],
    ['1.6.0', false],
    ['1.6.99', false],
    ['1.6.0-rc.1', false],
    ['0.9.9', false],
    ['1.7', false],
    ['latest', false],
    ['', false],
    [undefined, false],
    [null, false],
    [170, false],
  ])('%s → %s', (version, expected) => {
    expect(supportsApifyRunBody(version)).toBe(expected);
  });
});

describe('buildStartRunRequest', () => {
  it('apify: raw input body, options and base64 envVars in the query', () => {
    const envVars = { FOO: 'bar', NOTE: 'héllo ✓' };
    const { url, init } = buildStartRunRequest(config, 'my-actor', 'apify', {
      input: { query: 'x' },
      timeout: 60,
      memory: 512,
      envVars,
    });

    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/v2/acts/my-actor/runs');
    expect(parsed.searchParams.get('timeout')).toBe('60');
    expect(parsed.searchParams.get('memory')).toBe('512');
    const decoded = Buffer.from(parsed.searchParams.get('envVars'), 'base64').toString('utf8');
    expect(JSON.parse(decoded)).toEqual(envVars);
    expect(JSON.parse(init.body as string)).toEqual({ query: 'x' });
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok',
    });
  });

  it('apify: no options → no query string, and no input → `{}`', () => {
    const { url, init } = buildStartRunRequest(config, 'my-actor', 'apify', {
      envVars: {},
    });
    expect(url).toBe('http://api.test/v2/acts/my-actor/runs');
    expect(init.body).toBe('{}');
  });

  it('legacy: wrapped body with input always present, unset options omitted', () => {
    const { url, init } = buildStartRunRequest(config, 'my-actor', 'legacy', {
      input: { query: 'x' },
      envVars: { FOO: 'bar' },
    });
    expect(url).toBe('http://api.test/v2/acts/my-actor/runs');
    expect(JSON.parse(init.body as string)).toEqual({
      input: { query: 'x' },
      envVars: { FOO: 'bar' },
    });

    const empty = buildStartRunRequest(config, 'my-actor', 'legacy', { timeout: 60 });
    expect(JSON.parse(empty.init.body as string)).toEqual({ input: {}, timeout: 60 });
  });
});

describe('startRun version gate', () => {
  it('uses the Apify shape when /health reports the gate version', async () => {
    mockApi(() => jsonResponse({ status: 'ok', version: '1.7.0' }));

    const run = await startRun(config, 'my-actor', { input: { query: 'x' }, memory: 256 });

    expect(run).toEqual({ id: 'run-1', status: 'READY' });
    const [url, init] = runCall();
    expect(url).toBe('http://api.test/v2/acts/my-actor/runs?memory=256');
    expect(JSON.parse(init.body as string)).toEqual({ query: 'x' });
  });

  it('falls back to legacy when the version is below the gate', async () => {
    mockApi(() => jsonResponse({ status: 'ok', version: '1.6.0' }));

    await startRun(config, 'my-actor', { input: { query: 'x' } });

    const [url, init] = runCall();
    expect(url).toBe('http://api.test/v2/acts/my-actor/runs');
    expect(JSON.parse(init.body as string)).toEqual({ input: { query: 'x' } });
  });

  it.each([
    ['version missing', () => jsonResponse({ status: 'ok' })],
    ['garbage version', () => jsonResponse({ status: 'ok', version: 'dev' })],
    ['non-2xx /health', () => jsonResponse({}, 404)],
    [
      'non-JSON /health',
      () => ({ ok: true, status: 200, json: () => Promise.reject(new Error('x')) }),
    ],
    [
      'network error',
      () => {
        throw new Error('ECONNREFUSED');
      },
    ],
  ])('falls back to legacy on %s', async (_label, health) => {
    mockApi(health);

    await startRun(config, 'my-actor', { input: { query: 'x' } });

    const [, init] = runCall();
    expect(JSON.parse(init.body as string)).toEqual({ input: { query: 'x' } });
  });

  it('probes /health once per process and API URL', async () => {
    mockApi(() => jsonResponse({ status: 'ok', version: '1.7.0' }));

    await getRunBodyShape(config);
    await getRunBodyShape(config);
    await startRun(config, 'my-actor');
    await getRunBodyShape({ apiBaseUrl: 'http://other.test' });

    const healthCalls = fetchMock.mock.calls
      .map(([url]) => url as string)
      .filter((u) => u.endsWith('/health'));
    expect(healthCalls).toEqual(['http://api.test/health', 'http://other.test/health']);
  });

  it.each([
    ['apify', '1.6.0', { query: 'x' }],
    ['legacy', '1.7.0', { input: { query: 'x' } }],
    ['APIFY', '1.0.0', { query: 'x' }],
  ])('%s override wins over /health %s without probing', async (override, version, body) => {
    process.env[RUN_BODY_ENV] = override;
    mockApi(() => jsonResponse({ status: 'ok', version }));

    await startRun(config, 'my-actor', { input: { query: 'x' } });

    expect(fetchMock.mock.calls.some(([url]) => (url as string).endsWith('/health'))).toBe(false);
    const [, init] = runCall();
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('ignores an unknown override value and applies the gate', async () => {
    process.env[RUN_BODY_ENV] = 'wrapped';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockApi(() => jsonResponse({ status: 'ok', version: '1.7.0' }));

    await startRun(config, 'my-actor', { input: { query: 'x' } });

    expect(warn).toHaveBeenCalledOnce();
    const [, init] = runCall();
    expect(JSON.parse(init.body as string)).toEqual({ query: 'x' });
  });

  it('surfaces the API error message', async () => {
    process.env[RUN_BODY_ENV] = 'apify';
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Actor not found' } }, 404));

    await expect(startRun(config, 'nope')).rejects.toThrow('Actor not found');
  });
});
