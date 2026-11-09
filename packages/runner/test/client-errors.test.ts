import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type pg from 'pg';
import { logClientErrors, logPoolErrors } from '../src/client-errors.js';

const terminated = new Error('terminating connection due to administrator command');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logClientErrors', () => {
  it('turns an otherwise-fatal error event into a log line', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bare = new EventEmitter();
    expect(() => bare.emit('error', terminated)).toThrow(terminated);

    const client = logClientErrors(new EventEmitter(), 'redis');
    expect(() => client.emit('error', terminated)).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(`[redis] connection error: ${terminated.message}`);
  });
});

describe('logPoolErrors', () => {
  it('handles errors on the pool and on every client it connects', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = new EventEmitter();
    logPoolErrors(pool as unknown as pg.Pool, 'db');

    // Idle client error, re-emitted by pg-pool on the pool.
    expect(() => pool.emit('error', terminated)).not.toThrow();

    // Checked-out client: the error is emitted on the client itself.
    const client = new EventEmitter();
    pool.emit('connect', client);
    expect(() => client.emit('error', terminated)).not.toThrow();

    expect(errSpy).toHaveBeenCalledTimes(2);
  });
});
