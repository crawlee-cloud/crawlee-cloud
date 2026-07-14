/**
 * Unit tests for buildRunStatusMessage — the one place that turns a
 * container's death into an operator-readable status_message.
 *
 * Background (prod audit 2026-07-13): failed runs carried an EMPTY
 * status_message unless the runner itself threw. OOM kills were fully
 * invisible — one production actor had 7/8 runs exit 1 with no message,
 * while the Redis log tail showed `Command failed with signal "SIGKILL"`
 * (= the kernel OOM killer). Operators had to autopsy Redis log tails
 * (which expire in 24h) to learn what any failure actually was.
 */

import { describe, it, expect } from 'vitest';
import { buildRunStatusMessage } from '../src/queue.js';

describe('buildRunStatusMessage', () => {
  it('returns null for SUCCEEDED (no message noise on healthy runs)', () => {
    expect(
      buildRunStatusMessage({
        status: 'SUCCEEDED',
        exitCode: 0,
        oomKilled: false,
        memoryMb: 2048,
        timeoutSecs: 3600,
        lastErrorLine: null,
      })
    ).toBeNull();
  });

  it('names OOM explicitly, with the memory limit that was exceeded', () => {
    const msg = buildRunStatusMessage({
      status: 'FAILED',
      exitCode: 137,
      oomKilled: true,
      memoryMb: 2048,
      timeoutSecs: 3600,
      lastErrorLine: null,
    });
    expect(msg).toMatch(/out of memory/i);
    expect(msg).toContain('2048');
  });

  it('OOM wins over the generic failed message even when a log line exists', () => {
    const msg = buildRunStatusMessage({
      status: 'FAILED',
      exitCode: 137,
      oomKilled: true,
      memoryMb: 1024,
      timeoutSecs: 3600,
      lastErrorLine: 'some unrelated error line',
    });
    expect(msg).toMatch(/out of memory/i);
  });

  it('describes a timeout with the configured limit', () => {
    const msg = buildRunStatusMessage({
      status: 'TIMED-OUT',
      exitCode: 143,
      oomKilled: false,
      memoryMb: 2048,
      timeoutSecs: 3600,
      lastErrorLine: null,
    });
    expect(msg).toMatch(/timed out/i);
    expect(msg).toContain('3600');
  });

  it('includes the exit code and last ERROR log line for a plain failure', () => {
    const msg = buildRunStatusMessage({
      status: 'FAILED',
      exitCode: 1,
      oomKilled: false,
      memoryMb: 2048,
      timeoutSecs: 3600,
      lastErrorLine: 'Command failed with signal "SIGKILL"',
    });
    expect(msg).toContain('1');
    expect(msg).toContain('Command failed with signal "SIGKILL"');
  });

  it('still produces a message for a plain failure with no log line', () => {
    const msg = buildRunStatusMessage({
      status: 'FAILED',
      exitCode: 7,
      oomKilled: false,
      memoryMb: null,
      timeoutSecs: null,
      lastErrorLine: null,
    });
    expect(msg).toMatch(/exit(ed)? .*7/i);
  });

  it('collapses newlines and runs of whitespace in the log line to single spaces', () => {
    // status_message is a one-line dashboard field; a stack trace pasted
    // verbatim (newlines, indentation) breaks the layout.
    const msg = buildRunStatusMessage({
      status: 'FAILED',
      exitCode: 1,
      oomKilled: false,
      memoryMb: 2048,
      timeoutSecs: 3600,
      lastErrorLine:
        'TypeError: boom\n    at listOnTimeout (node:internal/timers:585:17)\n    at processTimers',
    });
    expect(msg).toContain(
      'TypeError: boom at listOnTimeout (node:internal/timers:585:17) at processTimers'
    );
    expect(msg).not.toMatch(/[\n\t]/);
  });

  it('truncates an oversized log line so status_message stays scannable', () => {
    const huge = 'x'.repeat(5000);
    const msg = buildRunStatusMessage({
      status: 'FAILED',
      exitCode: 1,
      oomKilled: false,
      memoryMb: 2048,
      timeoutSecs: 3600,
      lastErrorLine: huge,
    });
    expect(msg).not.toBeNull();
    expect(msg.length).toBeLessThanOrEqual(500);
  });
});
