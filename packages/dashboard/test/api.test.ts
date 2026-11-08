// @vitest-environment jsdom
/**
 * Tests for the api client's core plumbing (fetchApi) through
 * representative endpoint functions: bearer-token injection from
 * localStorage, Content-Type only-with-body rule, error unwrapping,
 * 204 handling, and list-endpoint querystring construction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// api.ts captures NEXT_PUBLIC_API_URL at module load. Pin it before the
// import below is evaluated (vi.hoisted runs first) so the hardcoded
// http://localhost:3000 assertions hold even when a developer has the
// variable exported in their shell.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = '';
});

import {
  getCurrentUser,
  listRuns,
  getRun,
  deleteActor,
  rerunRun,
  startRun,
  resetRunBodyShapeCache,
  supportsApifyRunBody,
  utf8ToBase64,
  wouldReadAsLegacy,
} from '@/lib/api';
// The API's own parser: what the server makes of the request the dashboard sends.
import { parseRunStartRequest } from '../../api/src/lib/run-body';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

// Node >= 25 ships a built-in `localStorage` global that is non-functional
// without --localstorage-file and shadows jsdom's implementation under
// vitest. Stub a working in-memory one so the suite runs on any Node.
const storageBacking = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storageBacking.get(key) ?? null,
  setItem: (key: string, value: string) => void storageBacking.set(key, String(value)),
  removeItem: (key: string) => void storageBacking.delete(key),
  clear: () => storageBacking.clear(),
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', localStorageStub);
  fetchMock.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchApi plumbing', () => {
  it('sends the bearer token from localStorage', async () => {
    localStorage.setItem('token', 'jwt-123');
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'u1' } }));

    await getCurrentUser();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/v2/auth/me');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-123');
  });

  it('omits the Authorization header when no token is stored', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'u1' } }));

    await getCurrentUser();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty('Authorization');
  });

  it('claims a JSON Content-Type only when a body is sent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }, 204));

    // Body-less DELETE — a Content-Type here used to trip Fastify's
    // FST_ERR_CTP_EMPTY_JSON_BODY and break every revoke/delete button.
    await deleteActor('actor-1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty('Content-Type');
  });

  it('unwraps the API error envelope into a thrown Error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { type: 'record-not-found', message: 'Run not found' } }, 404)
    );

    await expect(getRun('nope')).rejects.toThrow('Run not found');
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    });

    await expect(getRun('r1')).rejects.toThrow('Request failed');
  });
});

describe('rerunRun', () => {
  it('POSTs body-less to the rerun endpoint (no Content-Type)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { id: 'new-run', status: 'READY', retryCount: 0, originRunId: 'r1' } })
    );

    await rerunRun('r1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/v2/actor-runs/r1/rerun');
    expect(init.method).toBe('POST');
    // Body-less POST — a Content-Type here would trip Fastify's
    // FST_ERR_CTP_EMPTY_JSON_BODY, same regression class as deleteActor.
    expect(init.headers as Record<string, string>).not.toHaveProperty('Content-Type');
  });

  it('unwraps the envelope and passes lineage fields through typed', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { id: 'new-run', status: 'READY', retryCount: 0, originRunId: 'r1' } })
    );

    const run = await rerunRun('r1');

    // The NEW run's identity is what callers navigate to.
    expect(run.id).toBe('new-run');
    expect(run.originRunId).toBe('r1');
    expect(run.retryCount).toBe(0);
  });

  it('unwraps API errors (origin input reaped → 409)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            type: 'input-not-found',
            message: "The origin run's INPUT record no longer exists",
          },
        },
        409
      )
    );

    await expect(rerunRun('old-run')).rejects.toThrow(
      "The origin run's INPUT record no longer exists"
    );
  });
});

describe('startRun (Apify run-start contract, #115)', () => {
  const run = { id: 'run-1', status: 'READY' };

  /** Routes `/health` to `health` and run starts to a 201 with a run. */
  function mockApi(health: () => unknown = () => jsonResponse({ status: 'ok', version: '1.7.0' })) {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/health')) return Promise.resolve(health());
      return Promise.resolve(jsonResponse({ data: run }, 201));
    });
  }

  function runCall(): [string, RequestInit] {
    const call = fetchMock.mock.calls.find(([url]) => !(url as string).endsWith('/health'));
    return call as [string, RequestInit];
  }

  beforeEach(() => {
    resetRunBodyShapeCache();
    mockApi();
  });

  it('sends the input as the raw body and options in the query', async () => {
    const result = await startRun('actor-1', {
      input: { query: 'x', timeout: 'not-an-option' },
      timeout: 60,
      memory: 512,
    });

    const [url, init] = runCall();
    expect(url).toBe('http://localhost:3000/v2/acts/actor-1/runs?timeout=60&memory=512');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    // No `{ input: ... }` wrapper: an input key named `timeout` stays input.
    expect(JSON.parse(init.body as string)).toEqual({ query: 'x', timeout: 'not-an-option' });
    expect(result).toEqual(run);
  });

  it('sends `{}` and no query when there is no input or options', async () => {
    await startRun('actor-1');

    const [url, init] = runCall();
    expect(url).toBe('http://localhost:3000/v2/acts/actor-1/runs');
    expect(init.body).toBe('{}');
  });

  it('base64-encodes envVars as UTF-8 JSON', async () => {
    const envVars = { FOO: 'bar', GREETING: 'héllo ✓ 日本' };

    await startRun('actor-1', { envVars });

    const [url] = runCall();
    const encoded = new URL(url).searchParams.get('envVars');
    // Decode the way the API does (Buffer, utf8).
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual(envVars);
  });

  it.each([
    [{ input: 'x' }, true],
    [{ timeout: 30 }, true],
    [{ memory: 1, envVars: { A: 'b' } }, true],
    [{ input: 1, foo: 2 }, false],
    [{ query: 'x' }, false],
    [{}, false],
    [['input'], false],
    [null, false],
  ])('wouldReadAsLegacy(%j) → %s', (input, expected) => {
    expect(wouldReadAsLegacy(input)).toBe(expected);
  });

  /** Sends a run start and parses the captured request as the API does. */
  async function serverSees(options: Parameters<typeof startRun>[1]) {
    await startRun('actor-1', options);
    const [url, init] = runCall();
    const query = Object.fromEntries(new URL(url).searchParams);
    return {
      url,
      body: JSON.parse(init.body as string),
      parsed: parseRunStartRequest(JSON.parse(init.body as string), query),
    };
  }

  it.each([{ input: 'x' }, { timeout: 30 }, { query: 'x', timeout: 'soon' }, {}])(
    'input %j arrives unchanged with timeout/memory/envVars applied',
    async (input) => {
      const { parsed } = await serverSees({
        input,
        timeout: 99,
        memory: 256,
        envVars: { K: 'v' },
      });
      expect(parsed.input).toEqual(input);
      expect(parsed.timeout).toBe(99);
      expect(parsed.memory).toBe(256);
      expect(parsed.envVars).toEqual({ K: 'v' });
    }
  );

  it('sends legacy-looking input as the wrapper body without a query string', async () => {
    const { url, body, parsed } = await serverSees({ input: { timeout: 30 } });
    expect(url).toBe('http://localhost:3000/v2/acts/actor-1/runs');
    expect(body).toEqual({ input: { timeout: 30 } });
    expect(parsed.input).toEqual({ timeout: 30 });
    expect(parsed.timeout).toBeUndefined();
  });

  it.each([
    ['1.7.0', true],
    ['v1.7.0', true],
    ['1.7.0-rc.1', true],
    ['1.10.0', true],
    ['2.0.0', true],
    ['1.6.0', false],
    ['1.6.99', false],
    ['0.0.0', false],
    ['1.7', false],
    ['dev', false],
    [undefined, false],
  ])('supportsApifyRunBody(%j) → %s', (version, expected) => {
    expect(supportsApifyRunBody(version)).toBe(expected);
  });

  it.each([
    ['an older API', () => jsonResponse({ status: 'ok', version: '1.6.0' })],
    ['a missing version', () => jsonResponse({ status: 'ok' })],
    ['a failed /health', () => jsonResponse({}, 503)],
    [
      'a network error',
      () => {
        throw new Error('offline');
      },
    ],
  ])('sends the legacy wrapper to %s, options in the body', async (_label, health) => {
    mockApi(health);

    await startRun('actor-1', {
      input: { query: 'x' },
      timeout: 60,
      memory: 512,
      envVars: { K: 'v' },
    });

    const [url, init] = runCall();
    expect(url).toBe('http://localhost:3000/v2/acts/actor-1/runs');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ input: { query: 'x' }, timeout: 60, memory: 512, envVars: { K: 'v' } });
    const parsed = parseRunStartRequest(body, {});
    expect(parsed.input).toEqual({ query: 'x' });
    expect(parsed.timeout).toBe(60);
  });

  it('probes /health once per page session', async () => {
    await startRun('actor-1');
    await startRun('actor-1');

    const healthCalls = fetchMock.mock.calls.filter(([url]) => (url as string).endsWith('/health'));
    expect(healthCalls).toHaveLength(1);
  });

  it('encodes the actor id in the URL', async () => {
    await startRun('alice/a?b#c');

    const [url] = runCall();
    expect(new URL(url).pathname).toBe('/v2/acts/alice~a%3Fb%23c/runs');
  });

  it('utf8ToBase64 matches Buffer for non-Latin-1 text', () => {
    const text = '{"k":"€ ✓ 😀"}';
    expect(utf8ToBase64(text)).toBe(Buffer.from(text, 'utf8').toString('base64'));
  });
});

describe('list querystring construction', () => {
  it('serializes only the provided filters', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { items: [], total: 0, count: 0, offset: 0, limit: 50, desc: true } })
    );

    await listRuns({ status: 'FAILED', limit: 25, offset: 50, desc: false });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'http://localhost:3000/v2/actor-runs?status=FAILED&limit=25&offset=50&desc=false'
    );
  });

  it('omits the querystring entirely with no params', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { items: [], total: 0, count: 0, offset: 0, limit: 50, desc: true } })
    );

    await listRuns();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:3000/v2/actor-runs');
  });
});
