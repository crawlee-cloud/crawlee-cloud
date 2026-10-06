/**
 * waitForTerminal / parseWaitForFinish unit tests (fake timers).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  waitForTerminal,
  parseWaitForFinish,
  isTerminalStatus,
  MAX_WAIT_FOR_FINISH_SECS,
} from '../src/lib/wait-for-terminal.js';

interface Job {
  status: string;
}

const isTerminal = (j: Job) => isTerminalStatus(j.status);

/** Resolves-or-pending probe so tests can assert a promise has NOT settled yet. */
function track<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  void p.then((v) => {
    state.settled = true;
    state.value = v;
  });
  return state;
}

describe('waitForTerminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads once and returns when waitSecs is 0', async () => {
    const load = vi.fn().mockResolvedValue({ status: 'RUNNING' });
    const result = await waitForTerminal({ load, isTerminal, waitSecs: 0 });
    expect(result).toEqual({ status: 'RUNNING' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns immediately when the first load is already terminal', async () => {
    const load = vi.fn().mockResolvedValue({ status: 'SUCCEEDED' });
    const result = await waitForTerminal({ load, isTerminal, waitSecs: 20 });
    expect(result).toEqual({ status: 'SUCCEEDED' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns null immediately when load finds nothing', async () => {
    const load = vi.fn().mockResolvedValue(null);
    const result = await waitForTerminal({ load, isTerminal, waitSecs: 20 });
    expect(result).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns the terminal value as soon as a re-load sees it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const load = vi
      .fn()
      .mockResolvedValueOnce({ status: 'RUNNING' })
      .mockResolvedValueOnce({ status: 'RUNNING' })
      .mockResolvedValueOnce({ status: 'RUNNING' })
      .mockResolvedValue({ status: 'FAILED' });

    const probe = track(waitForTerminal({ load, isTerminal, waitSecs: 20 }));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(probe.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.settled).toBe(true);
    expect(probe.value).toEqual({ status: 'FAILED' });
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('returns the last non-terminal value once waitSecs elapse (with a final re-load)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // max jitter, still bounded by the deadline
    let n = 0;
    const load = vi.fn(async () => ({ status: 'RUNNING', n: ++n }));

    const probe = track(waitForTerminal({ load, isTerminal, waitSecs: 5 }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(probe.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.settled).toBe(true);
    expect(probe.value).toEqual({ status: 'RUNNING', n: load.mock.calls.length });
    // ~1 load per second plus the initial one; jitter only ever lengthens the gap.
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(load.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('adds at most 10% jitter to the interval', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const load = vi.fn().mockResolvedValue({ status: 'RUNNING' });

    void waitForTerminal({ load, isTerminal, waitSecs: 60, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_049);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stops on abort with the last loaded value and makes no further loads', async () => {
    const controller = new AbortController();
    const load = vi.fn().mockResolvedValue({ status: 'RUNNING' });

    const probe = track(
      waitForTerminal({ load, isTerminal, waitSecs: 60, signal: controller.signal })
    );
    await vi.advanceTimersByTimeAsync(2_500);
    const callsBeforeAbort = load.mock.calls.length;
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.settled).toBe(true);
    expect(probe.value).toEqual({ status: 'RUNNING' });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(callsBeforeAbort);
  });

  it('does not sleep when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const load = vi.fn().mockResolvedValue({ status: 'RUNNING' });
    const result = await waitForTerminal({
      load,
      isTerminal,
      waitSecs: 60,
      signal: controller.signal,
    });
    expect(result).toEqual({ status: 'RUNNING' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('propagates load errors', async () => {
    const load = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(waitForTerminal({ load, isTerminal, waitSecs: 5 })).rejects.toThrow('db down');
  });
});

describe('parseWaitForFinish', () => {
  it('defaults to 0 when absent', () => {
    expect(parseWaitForFinish({})).toBe(0);
    expect(parseWaitForFinish(undefined)).toBe(0);
  });

  it('coerces querystring integers', () => {
    expect(parseWaitForFinish({ waitForFinish: '20' })).toBe(20);
    expect(parseWaitForFinish({ waitForFinish: '0' })).toBe(0);
  });

  it(`clamps to ${String(MAX_WAIT_FOR_FINISH_SECS)}s`, () => {
    expect(parseWaitForFinish({ waitForFinish: '600' })).toBe(60);
    expect(parseWaitForFinish({ waitForFinish: '999999' })).toBe(60);
  });

  it.each(['-1', 'abc', '1.5'])('rejects %s', (v) => {
    expect(() => parseWaitForFinish({ waitForFinish: v })).toThrow(ZodError);
  });
});

describe('isTerminalStatus', () => {
  it.each(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'])('%s is terminal', (s) => {
    expect(isTerminalStatus(s)).toBe(true);
  });
  it.each(['READY', 'RUNNING', 'ABORTING'])('%s is not terminal', (s) => {
    expect(isTerminalStatus(s)).toBe(false);
  });
});
