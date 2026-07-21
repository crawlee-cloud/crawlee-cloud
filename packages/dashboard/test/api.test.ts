// @vitest-environment jsdom
/**
 * Tests for the api client's core plumbing (fetchApi) through
 * representative endpoint functions: bearer-token injection from
 * localStorage, Content-Type only-with-body rule, error unwrapping,
 * 204 handling, and list-endpoint querystring construction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getCurrentUser, listRuns, getRun, deleteActor } from '@/lib/api';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
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
