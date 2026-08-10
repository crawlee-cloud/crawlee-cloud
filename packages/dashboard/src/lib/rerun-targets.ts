import type { Run } from '@/lib/api';

/**
 * Statuses the rerun endpoint accepts — exactly the API's guard set.
 * SUCCEEDED is excluded on purpose: rerun is a recovery action; "run
 * again after success" belongs on the actor page where the input is
 * editable.
 *
 * A rerun creates a NEW run and leaves the origin row terminal, so rows
 * are additionally marked "already rerun" in-session (see `doneIds`
 * below) to keep a double-click from cloning twice.
 *
 * Shared by the runs list and the run detail page so the two can't drift
 * out of sync with each other or with the API's guard.
 */
export const RERUNNABLE = new Set<Run['status']>(['FAILED', 'TIMED-OUT', 'ABORTED']);

/**
 * Bulk-rerun candidates on the visible page, at most one per lineage
 * chain.
 *
 * The API allows exactly one active clone per chain, so firing at both
 * an origin and its own failed rerun (both terminal, both on this page)
 * guarantees a `409 rerun-already-active` for the second — a real
 * request reported to the operator as a failure they can do nothing
 * about. Chains are collapsed server-side, so `originRunId ?? id` IS the
 * chain key; keep the first row per key. The list is ordered
 * most-recent-first, so that's the newest attempt — the one whose input
 * is least likely to have been reaped.
 *
 * `doneIds` are rows whose rerun already succeeded this session, keyed
 * under both the row id and its chain key. `inFlightIds` are rows whose
 * per-row rerun POST hasn't answered yet: not in `doneIds` (that's set
 * on success only), but the chain is already spoken for, so bulk-firing
 * at them earns the same useless 409. Both are checked against the chain
 * key too — an in-flight rerun of an origin locks its sibling rows.
 *
 * Note the bulk button only renders under the "failed" filter, which is
 * FAILED + TIMED-OUT (see STATUS_GROUPS). ABORTED is rerunnable per-row
 * but deliberately has no bulk path: aborts are operator decisions, and
 * un-aborting a batch by accident is not a recovery action.
 */
export function bulkRerunTargets(
  rows: Run[],
  doneIds: Set<string>,
  inFlightIds: Set<string>
): Run[] {
  const seenChains = new Set<string>();
  return rows.filter((r) => {
    if (!RERUNNABLE.has(r.status) || doneIds.has(r.id) || inFlightIds.has(r.id)) return false;
    const chain = r.originRunId ?? r.id;
    if (seenChains.has(chain) || doneIds.has(chain) || inFlightIds.has(chain)) return false;
    seenChains.add(chain);
    return true;
  });
}
