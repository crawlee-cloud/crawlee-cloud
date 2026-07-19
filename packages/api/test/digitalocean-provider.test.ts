/**
 * DigitalOceanProvider tests.
 *
 * Mocks `fetch` to verify the contract between the scaler and the DO API:
 *   - Request shapes (createRunner POSTs the right body, listRunners
 *     filters by tag, destroyRunner DELETEs by id)
 *   - Response parsing (Droplet ID, public IP from networks.v4)
 *   - The active-Droplet polling loop with timeout
 *   - Error handling (4xx/5xx surfaces, 404 on destroy is tolerated so
 *     the reaper can't get stuck on already-deleted Droplets)
 *
 * Uses fake timers to make the 5s × 24-iteration polling loop run in
 * milliseconds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DigitalOceanProvider } from '../src/scaler/providers/digitalocean.js';
import type { RunnerConfig } from '../src/scaler/types.js';

const fetchMock = vi.fn();

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeTextResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

function makeRunnerConfig(): RunnerConfig {
  return {
    region: 'nyc3',
    size: 's-2vcpu-4gb',
    sshKeyId: 'ssh-key-12345',
    userData: '#!/bin/bash\necho hello',
    tags: ['auto-scaled'],
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DigitalOceanProvider', () => {
  describe('constructor', () => {
    it('throws when no token is provided', () => {
      expect(() => new DigitalOceanProvider({})).toThrow(/Missing DO_TOKEN/);
    });

    it('accepts DO_TOKEN', () => {
      expect(() => new DigitalOceanProvider({ DO_TOKEN: 'tok-1' })).not.toThrow();
    });

    it('accepts DIGITALOCEAN_TOKEN as a fallback', () => {
      expect(() => new DigitalOceanProvider({ DIGITALOCEAN_TOKEN: 'tok-2' })).not.toThrow();
    });
  });

  describe('createRunner', () => {
    it('POSTs the right body to /droplets', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(makeJsonResponse({ droplet: { id: 999 } }));
      fetchMock.mockResolvedValueOnce(
        makeJsonResponse({
          droplet: {
            status: 'active',
            networks: { v4: [{ ip_address: '203.0.113.10', type: 'public' }] },
          },
        })
      );

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      const promise = provider.createRunner(makeRunnerConfig());
      await vi.advanceTimersByTimeAsync(5000);
      await promise;

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.digitalocean.com/v2/droplets');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tok');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.region).toBe('nyc3');
      expect(body.size).toBe('s-2vcpu-4gb');
      expect(body.image).toBe('docker-20-04');
      expect(body.ssh_keys).toEqual(['ssh-key-12345']);
      expect(body.user_data).toBe('#!/bin/bash\necho hello');
      expect(body.tags).toContain('crawlee-runner'); // always added
      expect(body.tags).toContain('auto-scaled'); // user-supplied
      expect(body.monitoring).toBe(true);
    });

    it('extracts the public IP from the networks list', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(makeJsonResponse({ droplet: { id: 1 } }));
      fetchMock.mockResolvedValueOnce(
        makeJsonResponse({
          droplet: {
            status: 'active',
            networks: {
              v4: [
                { ip_address: '10.0.0.5', type: 'private' }, // ignore
                { ip_address: '203.0.113.42', type: 'public' }, // use this
              ],
            },
          },
        })
      );

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      const promise = provider.createRunner(makeRunnerConfig());
      await vi.advanceTimersByTimeAsync(5000);
      const info = await promise;

      expect(info.ip).toBe('203.0.113.42');
      expect(info.id).toBe('1');
      expect(info.status).toBe('creating');
      expect(info.activeRuns).toBe(0);
    });

    it('polls until the Droplet is active', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(makeJsonResponse({ droplet: { id: 7 } })); // POST
      // First two GETs return non-active
      fetchMock.mockResolvedValueOnce(
        makeJsonResponse({ droplet: { status: 'new', networks: { v4: [] } } })
      );
      fetchMock.mockResolvedValueOnce(
        makeJsonResponse({ droplet: { status: 'new', networks: { v4: [] } } })
      );
      // Third GET: active
      fetchMock.mockResolvedValueOnce(
        makeJsonResponse({
          droplet: {
            status: 'active',
            networks: { v4: [{ ip_address: '198.51.100.1', type: 'public' }] },
          },
        })
      );

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      const promise = provider.createRunner(makeRunnerConfig());
      await vi.advanceTimersByTimeAsync(15_000); // 3 × 5s
      const info = await promise;

      // 1 POST + 3 GETs = 4 fetch calls
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(info.ip).toBe('198.51.100.1');
    });

    it('throws after the polling timeout when the Droplet never becomes active', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(makeJsonResponse({ droplet: { id: 13 } }));
      // All 24 GETs return non-active
      for (let i = 0; i < 24; i++) {
        fetchMock.mockResolvedValueOnce(
          makeJsonResponse({ droplet: { status: 'new', networks: { v4: [] } } })
        );
      }

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      const promise = provider.createRunner(makeRunnerConfig());
      // Make sure we reject the promise so the test process doesn't carry an
      // unhandled rejection if the assertions below fail.
      const rejection = expect(promise).rejects.toThrow(/did not become active within 120s/);
      await vi.advanceTimersByTimeAsync(120_000);
      await rejection;
    });
  });

  describe('destroyRunner', () => {
    it('sends DELETE to /droplets/{id}', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      await provider.destroyRunner('42');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.digitalocean.com/v2/droplets/42');
      expect(init.method).toBe('DELETE');
    });

    it('tolerates 404 (Droplet already gone) — critical for the reaper', async () => {
      fetchMock.mockResolvedValueOnce(makeTextResponse('not found', 404));

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      // Without the fix this would throw and the reaper would log forever.
      await expect(provider.destroyRunner('42')).resolves.toBeUndefined();
    });

    it('throws on 500-level errors (real failure that needs a retry)', async () => {
      fetchMock.mockResolvedValueOnce(makeTextResponse('internal error', 500));

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      await expect(provider.destroyRunner('42')).rejects.toThrow(/500/);
    });
  });

  describe('listRunners', () => {
    it('filters Droplets by the crawlee-runner tag', async () => {
      fetchMock.mockResolvedValueOnce(makeJsonResponse({ droplets: [] }));

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      await provider.listRunners();

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain('tag_name=crawlee-runner');
      expect(url).toContain('per_page=100');
    });

    it('maps active Droplets to status="ready" with public IP', async () => {
      fetchMock.mockResolvedValueOnce(
        makeJsonResponse({
          droplets: [
            {
              id: 100,
              name: 'crawlee-runner-1',
              status: 'active',
              created_at: '2026-04-01T12:00:00Z',
              networks: {
                v4: [
                  { ip_address: '10.1.1.1', type: 'private' },
                  { ip_address: '203.0.113.99', type: 'public' },
                ],
              },
            },
          ],
        })
      );

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      const runners = await provider.listRunners();

      expect(runners).toHaveLength(1);
      expect(runners[0]).toMatchObject({
        id: '100', // string, not number
        ip: '203.0.113.99',
        status: 'ready',
        activeRuns: 0,
      });
      expect(runners[0].createdAt).toEqual(new Date('2026-04-01T12:00:00Z'));
    });

    it('maps non-active Droplets to status="creating"', async () => {
      fetchMock.mockResolvedValueOnce(
        makeJsonResponse({
          droplets: [
            {
              id: 200,
              name: 'crawlee-runner-2',
              status: 'new',
              created_at: '2026-04-01T12:00:00Z',
              networks: { v4: [] },
            },
          ],
        })
      );

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      const runners = await provider.listRunners();

      expect(runners[0].status).toBe('creating');
      expect(runners[0].ip).toBe(''); // no public IP yet
    });
  });

  describe('getHourlyPrice', () => {
    it('resolves price_hourly from /v2/sizes and caches the response', async () => {
      const provider = new DigitalOceanProvider({ DO_TOKEN: 'test-token' });
      fetchMock.mockResolvedValueOnce(
        makeJsonResponse({
          sizes: [
            { slug: 's-2vcpu-4gb', price_hourly: 0.03571 },
            { slug: 's-4vcpu-8gb', price_hourly: 0.07143 },
          ],
        })
      );

      expect(await provider.getHourlyPrice('s-4vcpu-8gb')).toBeCloseTo(0.07143, 6);
      // Second lookup hits the cache — no extra fetch
      expect(await provider.getHourlyPrice('s-2vcpu-4gb')).toBeCloseTo(0.03571, 6);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns null for an unknown slug and on API failure', async () => {
      const provider = new DigitalOceanProvider({ DO_TOKEN: 'test-token' });
      fetchMock.mockResolvedValueOnce(makeTextResponse('boom', 500));

      expect(await provider.getHourlyPrice('s-4vcpu-8gb')).toBeNull();
    });
  });

  describe('doRequest error surfacing', () => {
    it('includes the status code and body in the thrown message', async () => {
      fetchMock.mockResolvedValueOnce(makeTextResponse('rate limited', 429));

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      await expect(provider.listRunners()).rejects.toThrow(/429.*rate limited/);
    });

    it('handles 204 No Content responses without parsing JSON', async () => {
      // 204 has no body; calling .json() would throw. The provider must
      // return early on 204 — used by destroyRunner's normal success path.
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const provider = new DigitalOceanProvider({ DO_TOKEN: 'tok' });
      await expect(provider.destroyRunner('1')).resolves.toBeUndefined();
    });
  });
});
