/**
 * Poll-based scheduler — replaces per-schedule cron.schedule()
 * registrations with one global tick loop that polls the schedules
 * table every SCHEDULER_TICK_SECS. The leader (winner of the
 * scheduler advisory lock) fires due schedules and advances
 * next_run_at via cron-parser. Followers no-op.
 *
 * See docs/superpowers/specs/2026-06-03-api-multi-replica-design.md §2
 * for the rationale (multi-replica safety + propagation of schedule
 * mutations without per-replica state).
 */

import { CronExpressionParser } from 'cron-parser';
import { nanoid } from 'nanoid';
import { query, withAdvisoryLock, LOCK_IDS } from './db/index.js';
import { redis } from './storage/redis.js';
import { config } from './config.js';

interface ScheduleRow {
  id: string;
  user_id: string;
  actor_id: string;
  cron_expression: string;
  timezone: string;
  input: unknown;
  last_run_at: Date | null;
  next_run_at: Date | null;
}

let tickHandle: ReturnType<typeof setInterval> | null = null;

export function computeNextRun(expr: string, tz: string | null | undefined): Date {
  return CronExpressionParser.parse(expr, { tz: tz || 'UTC' })
    .next()
    .toDate();
}

export async function initScheduler(): Promise<void> {
  const intervalSecs = config.schedulerTickSecs;
  console.log(`[Scheduler] Starting tick every ${String(intervalSecs)}s`);
  // Initial tick so a fresh deploy doesn't wait the full interval. Tick
  // errors must be surfaced — otherwise a transient pool exhaustion or
  // PG flap would silently freeze all schedule firing.
  runSchedulerTick().catch((err: unknown) => {
    console.error('[Scheduler] tick failed:', err);
  });
  tickHandle = setInterval(() => {
    runSchedulerTick().catch((err: unknown) => {
      console.error('[Scheduler] tick failed:', err);
    });
  }, intervalSecs * 1000);
}

export function stopScheduler(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

export async function runSchedulerTick(): Promise<void> {
  const r = await withAdvisoryLock(LOCK_IDS.scheduler, async (client) => {
    const due = await client.query<ScheduleRow>(
      `SELECT id, user_id, actor_id, cron_expression, timezone, input,
              last_run_at, next_run_at
         FROM schedules
        WHERE is_enabled = true
          AND (next_run_at IS NULL OR next_run_at <= NOW())`
    );

    for (const s of due.rows) {
      let nextRun: Date;
      try {
        nextRun = computeNextRun(s.cron_expression, s.timezone);
      } catch (err) {
        console.error(
          `[Scheduler] Invalid cron expression for schedule ${s.id}: ${s.cron_expression} (${(err as Error).message})`
        );
        continue;
      }

      if (s.next_run_at === null) {
        // Warm-up: backfill next_run_at without firing. Legacy rows from
        // pre-multi-replica deploys land here on first contact.
        await client.query(
          'UPDATE schedules SET next_run_at = $1, modified_at = NOW() WHERE id = $2',
          [nextRun, s.id]
        );
        continue;
      }

      await triggerScheduledRun(s);
      await client.query(
        `UPDATE schedules
           SET last_run_at = NOW(), next_run_at = $1, modified_at = NOW()
         WHERE id = $2`,
        [nextRun, s.id]
      );
    }
    return due.rows.length;
  });
  if (!r.acquired) return;
}

async function triggerScheduledRun(schedule: ScheduleRow): Promise<void> {
  try {
    const runId = nanoid();
    const datasetId = nanoid();
    const kvStoreId = nanoid();
    const requestQueueId = nanoid();

    // Look up the actor's default_run_options so scheduled runs honor the
    // operator-configured timeout/memory instead of falling back to the
    // DB's column defaults (3600 / 1024). Previously the INSERT omitted
    // these columns entirely, so scheduled runs were always killed at
    // 3600s regardless of the actor's configured timeoutSecs.
    //
    // If the actor was deleted between the schedule firing and this read,
    // bail before creating storage rows + an S3 write that would orphan
    // when the downstream `runs` INSERT fails its actor_id FK check.
    const actorRow = await query<{
      default_run_options: { timeoutSecs?: number; memoryMbytes?: number } | null;
    }>('SELECT default_run_options FROM actors WHERE id = $1', [schedule.actor_id]);
    if (!actorRow.rows[0]) {
      console.error(
        `Schedule ${schedule.id} references missing actor ${schedule.actor_id}; skipping (consider deleting the schedule)`
      );
      return;
    }
    const actorDefaults = actorRow.rows[0].default_run_options ?? null;
    const timeoutSecs = actorDefaults?.timeoutSecs ?? 3600;
    const memoryMbytes = actorDefaults?.memoryMbytes ?? 1024;

    // Create default storages
    await query('INSERT INTO datasets (id, user_id) VALUES ($1, $2)', [
      datasetId,
      schedule.user_id,
    ]);
    await query('INSERT INTO key_value_stores (id, user_id) VALUES ($1, $2)', [
      kvStoreId,
      schedule.user_id,
    ]);
    await query('INSERT INTO request_queues (id, user_id) VALUES ($1, $2)', [
      requestQueueId,
      schedule.user_id,
    ]);

    const { putKVRecord } = await import('./storage/s3.js');
    await putKVRecord(kvStoreId, 'INPUT', JSON.stringify(schedule.input ?? {}), 'application/json');

    await query(
      `INSERT INTO runs (id, actor_id, user_id, status, default_dataset_id, default_key_value_store_id, default_request_queue_id, timeout_secs, memory_mbytes)
       VALUES ($1, $2, $3, 'READY', $4, $5, $6, $7, $8)`,
      [
        runId,
        schedule.actor_id,
        schedule.user_id,
        datasetId,
        kvStoreId,
        requestQueueId,
        timeoutSecs,
        memoryMbytes,
      ]
    );

    await redis.publish('run:new', runId);

    console.log(`Schedule ${schedule.id} triggered run ${runId} for actor ${schedule.actor_id}`);
  } catch (err) {
    console.error(`Schedule ${schedule.id} failed to trigger run:`, err);
  }
}
