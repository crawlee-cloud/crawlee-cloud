/**
 * followPull — regression tests for the swallowed in-body pull error.
 *
 * Background: docker-modem's followProgress treats a clean stream end as
 * success. The Docker daemon reports pull failures (disk full, auth,
 * registry rate-limit) as in-body `{"error": ...}` JSON frames on an
 * HTTP 200 stream — the transport 'error' event never fires for those, so
 * onFinished gets err=null and the runner logged "pulled successfully" for
 * pulls that failed. The run then died at createContainer with a
 * misleading "(HTTP code 404) No such image". Reproduced against
 * docker-modem 5.0.6 (lib/modem.js processLine/onStreamEnd). followPull
 * inspects the progress frames so the real cause surfaces at the pull.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  followPull,
  pullWithRetries,
  type PullModem,
  type PullProgressEvent,
} from '../src/docker.js';

/**
 * Fake modem that replays frames through onProgress, then finishes the way
 * docker-modem does: onFinished(err) where err is ONLY ever a transport
 * error — in-body error frames still finish with err=null.
 */
function fakeModem(frames: PullProgressEvent[], transportErr: Error | null = null): PullModem {
  return {
    followProgress: (_stream, onFinished, onProgress) => {
      for (const frame of frames) onProgress?.(frame);
      onFinished(transportErr);
    },
  };
}

const stream = null as unknown as NodeJS.ReadableStream;

describe('followPull', () => {
  it('resolves on a clean pull (status frames only)', async () => {
    const modem = fakeModem([
      { status: 'Pulling from library/foo' },
      { status: 'Downloading' },
      { status: 'Pull complete' },
    ]);

    await expect(followPull(modem, stream)).resolves.toBeUndefined();
  });

  it('rejects when an in-body error frame arrives, even though onFinished reports success', async () => {
    const modem = fakeModem([
      { status: 'Downloading' },
      {
        error: 'write /var/lib/docker/tmp/GetImageBlob123: no space left on device',
        errorDetail: {
          message: 'write /var/lib/docker/tmp/GetImageBlob123: no space left on device',
        },
      },
    ]);

    await expect(followPull(modem, stream)).rejects.toThrow(/no space left on device/);
  });

  it('prefers errorDetail.message over the bare error string', async () => {
    const modem = fakeModem([
      { error: 'terse', errorDetail: { message: 'detailed daemon cause' } },
    ]);

    await expect(followPull(modem, stream)).rejects.toThrow(/detailed daemon cause/);
  });

  it('still rejects on transport-level stream errors (the one path the old code handled)', async () => {
    const modem = fakeModem([{ status: 'Downloading' }], new Error('socket hang up'));

    await expect(followPull(modem, stream)).rejects.toThrow(/socket hang up/);
  });

  it('transport error wins when both are present (it is the more fundamental failure)', async () => {
    const modem = fakeModem([{ error: 'in-body' }], new Error('socket hang up'));

    await expect(followPull(modem, stream)).rejects.toThrow(/socket hang up/);
  });
});

describe('pullWithRetries', () => {
  // Background (prod 2026-07-16): a fleet scale-up cold-pulls the same
  // multi-GB image on every new droplet at once; 4 pulls died on
  // transient mid-transfer errors and their runs failed permanently —
  // nothing upstream retries a run that died before its container
  // existed. Retrying the pull itself rides out the blip.
  const noSleep = () => Promise.resolve();

  it('returns on first success without retrying', async () => {
    const attempt = vi.fn().mockResolvedValue(undefined);

    await pullWithRetries(attempt, { delaysMs: [1, 1], sleep: noSleep });

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries through transient failures and succeeds', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('unexpected EOF'))
      .mockRejectedValueOnce(new Error('registry 503'))
      .mockResolvedValueOnce(undefined);
    const onRetry = vi.fn();

    await pullWithRetries(attempt, { delaysMs: [1, 1], sleep: noSleep, onRetry });

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(
      1,
      1,
      expect.objectContaining({ message: 'unexpected EOF' })
    );
  });

  it('throws the LAST error once retries are exhausted', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('final cause'));

    await expect(pullWithRetries(attempt, { delaysMs: [1, 1], sleep: noSleep })).rejects.toThrow(
      'final cause'
    );
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does not swallow a permanent failure into infinite retries (attempts = delays + 1)', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('manifest unknown'));

    await expect(pullWithRetries(attempt, { delaysMs: [], sleep: noSleep })).rejects.toThrow(
      'manifest unknown'
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the run is aborted — no pinning the slot through the retry window', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('registry 503'));

    await expect(
      pullWithRetries(attempt, { delaysMs: [1, 1], sleep: noSleep, isAborted: () => true })
    ).rejects.toThrow('registry 503');

    expect(attempt).toHaveBeenCalledTimes(1); // no retry once aborted
  });
});
