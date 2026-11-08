/**
 * Unit tests for the CLI's pure formatting helpers (list/status/logs)
 * and call.ts's env collector. Chalk color codes are stripped before
 * asserting — CI runs with NO_COLOR anyway, and the tests should not
 * depend on the terminal.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { timeAgo, statusColor } from '../src/commands/list.js';
import { formatDuration, formatStatus as formatRunStatus } from '../src/commands/status.js';
import { formatLevel, formatStatus as formatLogStatus } from '../src/commands/logs.js';
import { Command, InvalidArgumentError } from 'commander';
import { collectEnvVars, parsePositiveInt } from '../src/commands/call.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('timeAgo', () => {
  it('walks the ladder from minutes to days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00Z'));

    expect(timeAgo('2026-07-21T11:59:40Z')).toBe('just now');
    expect(timeAgo('2026-07-21T11:15:00Z')).toBe('45m ago');
    expect(timeAgo('2026-07-21T07:00:00Z')).toBe('5h ago');
    expect(timeAgo('2026-07-18T12:00:00Z')).toBe('3d ago');
  });
});

describe('statusColor (list)', () => {
  it.each(['SUCCEEDED', 'FAILED', 'RUNNING', 'READY', 'TIMED-OUT', 'ABORTED'])(
    'renders %s with its own styling but unchanged text',
    (status) => {
      expect(stripAnsi(statusColor(status))).toBe(status);
    }
  );

  it('passes unknown statuses through untouched', () => {
    expect(statusColor('SOMETHING-NEW')).toBe('SOMETHING-NEW');
  });
});

describe('formatDuration (status)', () => {
  it('picks the right unit per magnitude', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(59_999)).toBe('60.0s');
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});

describe('formatStatus (status)', () => {
  it('badges known lifecycle states', () => {
    expect(stripAnsi(formatRunStatus('SUCCEEDED'))).toBe('✓ SUCCEEDED');
    expect(stripAnsi(formatRunStatus('FAILED'))).toBe('✗ FAILED');
    expect(stripAnsi(formatRunStatus('RUNNING'))).toBe('⟳ RUNNING');
    expect(stripAnsi(formatRunStatus('TIMED-OUT'))).toBe('⏰ TIMED-OUT');
  });

  it('passes unknown statuses through', () => {
    expect(formatRunStatus('MYSTERY')).toBe('MYSTERY');
  });
});

describe('formatLevel / formatStatus (logs)', () => {
  it('abbreviates log levels to three letters', () => {
    expect(stripAnsi(formatLevel('error'))).toBe('ERR');
    expect(stripAnsi(formatLevel('WARNING'))).toBe('WRN');
    expect(stripAnsi(formatLevel('info'))).toBe('INF');
    expect(stripAnsi(formatLevel('debug'))).toBe('DBG');
    expect(stripAnsi(formatLevel('verbose'))).toBe('VER');
  });

  it('badges run statuses', () => {
    expect(stripAnsi(formatLogStatus('SUCCEEDED'))).toBe('✓ SUCCEEDED');
    expect(stripAnsi(formatLogStatus('UNKNOWN'))).toBe('UNKNOWN');
  });
});

describe('collectEnvVars (call)', () => {
  it('accumulates pairs and preserves equals in values', () => {
    const one = collectEnvVars('A=1', {});
    const two = collectEnvVars('B=x=y', one);
    expect(two).toEqual({ A: '1', B: 'x=y' });
  });

  it('throws InvalidArgumentError on malformed input (Commander reports it and exits)', () => {
    expect(() => collectEnvVars('NOEQUALS', {})).toThrow(InvalidArgumentError);
    expect(() => collectEnvVars('=value', {})).toThrow('Use KEY=VALUE.');
  });
});

describe('parsePositiveInt (call --timeout / --memory)', () => {
  it('parses positive integers', () => {
    expect(parsePositiveInt('30')).toBe(30);
    expect(parsePositiveInt('1024')).toBe(1024);
  });

  it.each(['0', '-5', '2.5', 'abc', '', '0x10', '1e3', '0b11', ' 30', '+30', '30s', '00'])(
    'throws InvalidArgumentError for %j',
    (value) => {
      expect(() => parsePositiveInt(value)).toThrow(InvalidArgumentError);
      expect(() => parsePositiveInt(value)).toThrow('Use a positive integer.');
    }
  );

  it('is reported by Commander as an invalid option argument', () => {
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined })
      .option('-t, --timeout <seconds>', 'Timeout', parsePositiveInt);

    let error: unknown;
    try {
      program.parse(['node', 'crc', '-t', 'soon']);
    } catch (e) {
      error = e;
    }
    expect((error as { code?: string }).code).toBe('commander.invalidArgument');
    expect((error as Error).message).toContain('Use a positive integer.');
  });
});
