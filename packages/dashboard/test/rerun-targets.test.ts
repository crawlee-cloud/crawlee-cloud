/**
 * Tests for bulk-rerun target selection.
 *
 * Everything here protects one operator-visible property: a request the
 * dashboard fires must never come back `409 rerun-already-active`. The
 * API enforces one active clone per lineage chain with an advisory lock,
 * so a duplicate isn't a data problem — it's a real POST reported to the
 * operator as "rerun failed" for a rerun that is, in fact, running.
 */
import { describe, it, expect } from 'vitest';
import { RERUNNABLE, bulkRerunTargets } from '@/lib/rerun-targets';
import type { Run } from '@/lib/api';

/** Minimal Run row — only the fields the selector reads. */
function run(id: string, status: Run['status'], originRunId?: string): Run {
  return {
    id,
    actId: 'act1',
    status,
    defaultDatasetItemCount: null,
    ...(originRunId ? { originRunId } : {}),
  } as Run;
}

const none = new Set<string>();
const ids = (rows: Run[]) => rows.map((r) => r.id);

describe('RERUNNABLE', () => {
  it('matches the API guard set — terminal failures only', () => {
    expect([...RERUNNABLE].sort()).toEqual(['ABORTED', 'FAILED', 'TIMED-OUT']);
  });

  it('excludes SUCCEEDED — rerun is recovery, not "run again"', () => {
    expect(RERUNNABLE.has('SUCCEEDED')).toBe(false);
  });

  it('excludes non-terminal states the endpoint would reject', () => {
    for (const s of ['READY', 'RUNNING', 'ABORTING'] as Run['status'][]) {
      expect(RERUNNABLE.has(s)).toBe(false);
    }
  });
});

describe('bulkRerunTargets', () => {
  it('keeps only rerunnable rows', () => {
    const rows = [
      run('a', 'FAILED'),
      run('b', 'SUCCEEDED'),
      run('c', 'RUNNING'),
      run('d', 'TIMED-OUT'),
      run('e', 'ABORTED'),
    ];
    expect(ids(bulkRerunTargets(rows, none, none))).toEqual(['a', 'd', 'e']);
  });

  it('collapses a lineage chain to its newest row', () => {
    // Most-recent-first ordering: the rerun of `origin` precedes it, and
    // its input is the least likely to have been reaped.
    const rows = [run('retry', 'FAILED', 'origin'), run('origin', 'FAILED')];
    expect(ids(bulkRerunTargets(rows, none, none))).toEqual(['retry']);
  });

  it('collapses siblings that share an origin but not each other', () => {
    const rows = [
      run('r2', 'FAILED', 'origin'),
      run('r1', 'TIMED-OUT', 'origin'),
      run('other', 'FAILED'),
    ];
    expect(ids(bulkRerunTargets(rows, none, none))).toEqual(['r2', 'other']);
  });

  it('skips rows already rerun this session, by row id', () => {
    const rows = [run('a', 'FAILED'), run('b', 'FAILED')];
    expect(ids(bulkRerunTargets(rows, new Set(['a']), none))).toEqual(['b']);
  });

  it('skips a row whose chain key was already rerun via a sibling', () => {
    // markRerunDone records both the row id and its chain key, so a
    // per-row rerun of `retry` also takes `origin` out of bulk range.
    const rows = [run('origin', 'FAILED')];
    expect(ids(bulkRerunTargets(rows, new Set(['retry', 'origin']), none))).toEqual([]);
  });

  it('skips rows with a rerun POST still in flight', () => {
    // The regression this guards: in-flight rows are NOT in doneIds
    // (that is set on success only), so without the inFlight check a
    // bulk run fires a second POST at a chain already claimed.
    const rows = [run('a', 'FAILED'), run('b', 'FAILED')];
    expect(ids(bulkRerunTargets(rows, none, new Set(['a'])))).toEqual(['b']);
  });

  it('locks sibling rows while an in-flight rerun holds the chain', () => {
    const rows = [run('retry', 'FAILED', 'origin'), run('unrelated', 'FAILED')];
    expect(ids(bulkRerunTargets(rows, none, new Set(['origin'])))).toEqual(['unrelated']);
  });

  it('returns nothing when every candidate is done or in flight', () => {
    const rows = [run('a', 'FAILED'), run('b', 'FAILED')];
    expect(bulkRerunTargets(rows, new Set(['a']), new Set(['b']))).toEqual([]);
  });

  it('is a pure filter — no mutation of the input rows or sets', () => {
    const rows = [run('a', 'FAILED'), run('b', 'FAILED')];
    const done = new Set(['a']);
    const inFlight = new Set<string>();
    bulkRerunTargets(rows, done, inFlight);
    expect(rows).toHaveLength(2);
    expect([...done]).toEqual(['a']);
    expect(inFlight.size).toBe(0);
  });
});
