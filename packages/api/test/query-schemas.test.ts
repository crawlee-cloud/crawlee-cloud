/**
 * Query-string schema tests: Apify-client wire formats (booleans as 1/0,
 * status arrays comma-joined, startedAfter/startedBefore names).
 */

import { describe, it, expect } from 'vitest';
import { zBoolQuery } from '../src/schemas/common.js';
import { ListRunsQuerySchema } from '../src/schemas/runs.js';

describe('zBoolQuery', () => {
  it.each([
    ['true', true],
    ['1', true],
    [true, true],
    ['false', false],
    ['0', false],
    [false, false],
    [undefined, undefined],
  ])('parses %j as %j', (input, expected) => {
    expect(zBoolQuery.parse(input)).toBe(expected);
  });

  it.each(['yes', 'TRUE', '', '2', 1, null])('rejects %j', (input) => {
    expect(zBoolQuery.safeParse(input).success).toBe(false);
  });
});

describe('ListRunsQuerySchema', () => {
  it('defaults desc to true when absent', () => {
    expect(ListRunsQuerySchema.parse({}).desc).toBe(true);
  });

  it.each([
    ['0', false],
    ['1', true],
    ['false', false],
    ['true', true],
  ])('parses desc=%s as %s', (desc, expected) => {
    expect(ListRunsQuerySchema.parse({ desc }).desc).toBe(expected);
  });

  it('parses a single status into a one-element list', () => {
    expect(ListRunsQuerySchema.parse({ status: 'SUCCEEDED' }).status).toEqual(['SUCCEEDED']);
  });

  it('accepts TIMING-OUT', () => {
    expect(ListRunsQuerySchema.parse({ status: 'TIMING-OUT' }).status).toEqual(['TIMING-OUT']);
  });

  it('splits a comma-separated status list', () => {
    expect(ListRunsQuerySchema.parse({ status: 'SUCCEEDED,FAILED' }).status).toEqual([
      'SUCCEEDED',
      'FAILED',
    ]);
  });

  it('flattens a repeated status param', () => {
    expect(ListRunsQuerySchema.parse({ status: ['SUCCEEDED', 'FAILED,ABORTED'] }).status).toEqual([
      'SUCCEEDED',
      'FAILED',
      'ABORTED',
    ]);
  });

  it.each(['BOGUS', 'SUCCEEDED,BOGUS', '', ','])('rejects status=%j', (status) => {
    expect(ListRunsQuerySchema.safeParse({ status }).success).toBe(false);
  });

  it('maps startedAfter/startedBefore onto since/until', () => {
    const q = ListRunsQuerySchema.parse({
      startedAfter: '2026-01-01T00:00:00.000Z',
      startedBefore: '2026-02-01T00:00:00.000Z',
    });
    expect(q.since).toBe('2026-01-01T00:00:00.000Z');
    expect(q.until).toBe('2026-02-01T00:00:00.000Z');
    expect(q).not.toHaveProperty('startedAfter');
    expect(q).not.toHaveProperty('startedBefore');
  });

  it('prefers explicit since/until over the aliases', () => {
    const q = ListRunsQuerySchema.parse({
      since: '2026-03-01T00:00:00.000Z',
      startedAfter: '2026-01-01T00:00:00.000Z',
      until: '2026-04-01T00:00:00.000Z',
      startedBefore: '2026-02-01T00:00:00.000Z',
    });
    expect(q.since).toBe('2026-03-01T00:00:00.000Z');
    expect(q.until).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rejects a non-ISO startedAfter', () => {
    expect(ListRunsQuerySchema.safeParse({ startedAfter: 'yesterday' }).success).toBe(false);
  });

  it('strips unknown Apify params instead of rejecting them', () => {
    const q = ListRunsQuerySchema.parse({ unnamed: '1', clean: '0' });
    expect(q).not.toHaveProperty('unnamed');
    expect(q).not.toHaveProperty('clean');
  });
});
