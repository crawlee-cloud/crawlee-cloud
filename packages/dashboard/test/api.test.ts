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

import { getCurrentUser, listRuns, getRun, deleteActor, rerunRun } from '@/lib/api';

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
