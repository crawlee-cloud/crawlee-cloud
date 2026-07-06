/**
 * waitWithTimeout — the container-wait race used by executeRun.
 *
 * Regression: the old inline Promise.race left its setTimeout live after
 * a normal container exit, leaking one timer per completed run for up to
 * timeoutSecs (default 3600s) and delaying graceful shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitWithTimeout } from '../src/wait.js';

describe('waitWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the promise result when it settles before the timeout', async () => {
    const result = await waitWithTimeout(Promise.resolve({ StatusCode: 0 }), 60_000);
    expect(result).toEqual({ timedOut: false, value: { StatusCode: 0 } });
  });

  it('clears its timer once the promise settles (no 1-hour leak per run)', async () => {
    await waitWithTimeout(Promise.resolve({ StatusCode: 0 }), 3_600_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports timedOut when the promise outlives the timeout', async () => {
    const never = new Promise<never>(() => {});
    const pending = waitWithTimeout(never, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ timedOut: true });
  });

  it('propagates promise rejections (non-timeout errors must not be swallowed)', async () => {
    const rejected = Promise.reject(new Error('docker daemon gone'));
    await expect(waitWithTimeout(rejected, 5_000)).rejects.toThrow('docker daemon gone');
    expect(vi.getTimerCount()).toBe(0);
  });
});
