/**
 * Webhook routes - CRUD endpoints for managing webhooks and viewing delivery history.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { CreateWebhookSchema, UpdateWebhookSchema } from '../schemas/webhooks.js';
import { query } from '../db/index.js';
import { appendSearchCondition } from '../db/search.js';
import { authenticate } from '../auth/middleware.js';
import { applyWebhookTemplate } from '../webhooks/apply-template.js';

interface WebhookRow {
  id: string;
  user_id: string;
  event_types: string[];
  request_url: string;
  payload_template: string | null;
  actor_id: string | null;
  headers: Record<string, string> | null;
  description: string | null;
  is_enabled: boolean;
  created_at: Date;
  modified_at: Date;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  run_id: string | null;
  event_type: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: Date | null;
  response_status: number | null;
  response_body: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export const webhooksRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * POST /v2/webhooks - Create webhook
   */
  fastify.post<{
    Body: {
      eventTypes: string[];
      requestUrl: string;
      payloadTemplate?: string;
      actorId?: string;
      headers?: Record<string, string>;
      description?: string;
      isEnabled?: boolean;
    };
  }>('/webhooks', async (request, reply) => {
    const data = CreateWebhookSchema.parse(request.body);

    const id = nanoid();
    const result = await query<WebhookRow>(
      `INSERT INTO webhooks (id, user_id, event_types, request_url, payload_template, actor_id, headers, description, is_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        request.user!.id,
        data.eventTypes,
        data.requestUrl,
        data.payloadTemplate ?? null,
        data.actorId ?? null,
        data.headers ? JSON.stringify(data.headers) : null,
        data.description ?? null,
        data.isEnabled ?? true,
      ]
    );

    reply.status(201);
    return { data: formatWebhook(result.rows[0]!) };
  });

  /**
   * GET /v2/webhooks - List user's webhooks
   */
  fastify.get<{
    Querystring: { offset?: string; limit?: string; q?: string };
  }>('/webhooks', async (request) => {
    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(request.query.limit || '100', 10) || 100));

    // Webhooks have no `name` column — search instead matches against id,
    // description, and request_url so operators can find a hook by what
    // they typed in the description field or by domain.
    const params: unknown[] = [request.user!.id];
    const where = appendSearchCondition('user_id = $1', params, request.query.q || '', [
      'id',
      'description',
      'request_url',
    ]);

    const [countResult, pageResult] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM webhooks WHERE ${where}`,
        params
      ),
      query<WebhookRow>(
        `SELECT * FROM webhooks WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    return {
      data: {
        total,
        count: pageResult.rows.length,
        offset,
        limit,
        items: pageResult.rows.map(formatWebhook),
      },
    };
  });

  /**
   * GET /v2/webhooks/:webhookId - Get single webhook (user-scoped)
   */
  fastify.get<{ Params: { webhookId: string } }>('/webhooks/:webhookId', async (request, reply) => {
    const { webhookId } = request.params;

    const result = await query<WebhookRow>(
      'SELECT * FROM webhooks WHERE id = $1 AND user_id = $2',
      [webhookId, request.user!.id]
    );

    if (!result.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Webhook not found' } };
    }

    return { data: formatWebhook(result.rows[0]) };
  });

  /**
   * PUT /v2/webhooks/:webhookId - Update webhook (user-scoped)
   */
  fastify.put<{
    Params: { webhookId: string };
    Body: {
      eventTypes?: string[];
      requestUrl?: string;
      payloadTemplate?: string;
      actorId?: string;
      headers?: Record<string, string>;
      description?: string;
      isEnabled?: boolean;
    };
  }>('/webhooks/:webhookId', async (request, reply) => {
    const { webhookId } = request.params;
    const updates = UpdateWebhookSchema.parse(request.body);

    const setClauses: string[] = ['modified_at = NOW()'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.eventTypes !== undefined) {
      setClauses.push(`event_types = $${paramIndex++}`);
      values.push(updates.eventTypes);
    }
    if (updates.requestUrl !== undefined) {
      setClauses.push(`request_url = $${paramIndex++}`);
      values.push(updates.requestUrl);
    }
    if (updates.payloadTemplate !== undefined) {
      setClauses.push(`payload_template = $${paramIndex++}`);
      values.push(updates.payloadTemplate);
    }
    if (updates.actorId !== undefined) {
      setClauses.push(`actor_id = $${paramIndex++}`);
      values.push(updates.actorId);
    }
    if (updates.headers !== undefined) {
      setClauses.push(`headers = $${paramIndex++}`);
      values.push(JSON.stringify(updates.headers));
    }
    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(updates.description);
    }
    if (updates.isEnabled !== undefined) {
      setClauses.push(`is_enabled = $${paramIndex++}`);
      values.push(updates.isEnabled);
    }

    values.push(webhookId);

    // Add user_id filter for authorization
    values.push(request.user!.id);
    const result = await query<WebhookRow>(
      `UPDATE webhooks SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}
       RETURNING *`,
      values
    );

    if (!result.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Webhook not found' } };
    }

    return { data: formatWebhook(result.rows[0]) };
  });

  /**
   * DELETE /v2/webhooks/:webhookId - Delete webhook (user-scoped)
   */
  fastify.delete<{ Params: { webhookId: string } }>(
    '/webhooks/:webhookId',
    async (request, reply) => {
      const { webhookId } = request.params;
      const result = await query(
        'DELETE FROM webhooks WHERE id = $1 AND user_id = $2 RETURNING id',
        [webhookId, request.user!.id]
      );

      if (result.rowCount === 0) {
        reply.status(404);
        return { error: { type: 'record-not-found', message: 'Webhook not found' } };
      }

      reply.status(204);
    }
  );

  /**
   * GET /v2/webhooks/:webhookId/deliveries - List delivery history (user-scoped, paginated)
   */
  fastify.get<{
    Params: { webhookId: string };
    Querystring: { offset?: string; limit?: string };
  }>('/webhooks/:webhookId/deliveries', async (request, reply) => {
    const { webhookId } = request.params;
    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(request.query.limit || '100', 10) || 100));

    // Verify webhook ownership
    const webhook = await query<WebhookRow>(
      'SELECT * FROM webhooks WHERE id = $1 AND user_id = $2',
      [webhookId, request.user!.id]
    );

    if (!webhook.rows[0]) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Webhook not found' } };
    }

    const result = await query<DeliveryRow>(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [webhookId, limit, offset]
    );

    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM webhook_deliveries WHERE webhook_id = $1',
      [webhookId]
    );

    const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

    return {
      data: {
        total,
        count: result.rows.length,
        offset,
        limit,
        items: result.rows.map(formatDelivery),
      },
    };
  });

  /**
   * POST /v2/webhooks/:webhookId/test
   *
   * Fire a synthetic event at the webhook's configured URL — one shot, no
   * retries, 10s timeout. Records a row in `webhook_deliveries` with the
   * outcome so the test shows up in the same history the dashboard already
   * displays. The synthetic payload sets `test: true` and uses sentinel run
   * IDs so receivers can opt-out of side effects.
   *
   * Body (all optional):
   *   - eventType: string — pick a specific event the webhook is subscribed
   *     to. Useful when receivers branch by event (e.g. SUCCEEDED routes to
   *     a queue, FAILED posts to Slack). When omitted, defaults to the
   *     first configured event. To exercise *every* subscribed event the
   *     dashboard makes one parallel call per event with this field set.
   *
   * Synchronous: the response includes the delivery row so the UI can show
   * the result immediately without polling.
   */
  fastify.post<{
    Params: { webhookId: string };
    Body: { eventType?: string } | undefined;
  }>('/webhooks/:webhookId/test', async (request, reply) => {
    const { webhookId } = request.params;

    const webhookResult = await query<WebhookRow>(
      'SELECT * FROM webhooks WHERE id = $1 AND user_id = $2',
      [webhookId, request.user!.id]
    );
    const webhook = webhookResult.rows[0];
    if (!webhook) {
      reply.status(404);
      return { error: { type: 'record-not-found', message: 'Webhook not found' } };
    }

    // Default: first configured event. Override: any event the webhook is
    // subscribed to. Reject events the webhook isn't subscribed to so test
    // results match what the receiver would actually see in production —
    // receivers shouldn't have to handle events the platform "promised" not
    // to send them.
    const requestedEvent = request.body?.eventType;
    let eventType: string;
    if (requestedEvent) {
      if (!webhook.event_types.includes(requestedEvent)) {
        reply.status(400);
        return {
          error: {
            type: 'invalid-event-type',
            message: `Webhook is not subscribed to "${requestedEvent}". Subscribed: ${webhook.event_types.join(', ')}`,
          },
        };
      }
      eventType = requestedEvent;
    } else {
      eventType = webhook.event_types[0] ?? 'ACTOR.RUN.SUCCEEDED';
    }

    const deliveryId = nanoid();
    const result = await deliverTestWebhook(deliveryId, webhook, eventType);

    const formatted = formatDelivery(result);
    reply.status(result.status === 'DELIVERED' ? 200 : 502);
    return { data: formatted };
  });
};

/**
 * Apify-compatible webhook payload shape. Receivers reading documentation at
 * https://docs.apify.com/platform/integrations/webhooks expect this exact
 * structure, especially the `resource` block — that's where serious receivers
 * pull the full run context from (ids, status, timestamps, exit code, stats).
 *
 * Kept here AND mirrored in the runner's attemptWebhookDelivery default —
 * the snapshot test in webhooks.test.ts locks the shape so the two stay
 * aligned. The fields below are the minimum viable rich payload; expand
 * here when receivers need new fields.
 */
export interface WebhookRun {
  id: string;
  actorId: string;
  userId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  defaultDatasetId: string | null;
  defaultKeyValueStoreId: string | null;
  defaultRequestQueueId: string | null;
  timeoutSecs: number;
  memoryMbytes: number;
  buildId: string | null;
  buildNumber: string | null;
  exitCode: number | null;
  stats: {
    inputBodyLen: number;
    restartCount: number;
    resurrectCount: number;
    runTimeSecs: number;
    computeUnits: number;
  };
}

export interface WebhookPayload {
  userId: string;
  createdAt: string;
  eventType: string;
  eventData: { actorId: string; actorRunId: string };
  resource: {
    id: string;
    actId: string; // Apify alias for actorId
    userId: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    defaultDatasetId: string | null;
    defaultKeyValueStoreId: string | null;
    defaultRequestQueueId: string | null;
    options: { timeoutSecs: number; memoryMbytes: number };
    buildId: string | null;
    buildNumber: string | null;
    exitCode: number | null;
    stats: WebhookRun['stats'];
  };
  /** Marker so receivers can no-op side effects on test deliveries. */
  test?: boolean;
}

export function buildWebhookPayload(
  eventType: string,
  run: WebhookRun,
  options: { test?: boolean } = {}
): WebhookPayload {
  const payload: WebhookPayload = {
    userId: run.userId,
    createdAt: new Date().toISOString(),
    eventType,
    eventData: { actorId: run.actorId, actorRunId: run.id },
    resource: {
      id: run.id,
      actId: run.actorId,
      userId: run.userId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      defaultDatasetId: run.defaultDatasetId,
      defaultKeyValueStoreId: run.defaultKeyValueStoreId,
      defaultRequestQueueId: run.defaultRequestQueueId,
      options: { timeoutSecs: run.timeoutSecs, memoryMbytes: run.memoryMbytes },
      buildId: run.buildId,
      buildNumber: run.buildNumber,
      exitCode: run.exitCode,
      stats: run.stats,
    },
  };
  if (options.test) payload.test = true;
  return payload;
}

/**
 * Same private-URL guard the runner uses for production deliveries — kept
 * inline because it's small and tied to the test endpoint's threat model.
 * Blocks loopback, link-local / cloud metadata, and RFC 1918 ranges.
 */
function isPrivateUrl(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return true;
  }
  const hostname = parsed.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname.startsWith('169.254.')) return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p))) {
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (parts.every((p) => p === 0)) return true;
  }
  return false;
}

/**
 * One-shot synthetic delivery. Mirrors the runner's production payload
 * shape so receivers don't need a different parser, but adds `test: true`
 * and sentinel run IDs so the receiver can no-op side effects if it wants.
 */
async function deliverTestWebhook(
  deliveryId: string,
  webhook: WebhookRow,
  eventType: string
): Promise<DeliveryRow> {
  const now = new Date();
  const testRunId = `test-${deliveryId}`;

  const baseInsert = await query<DeliveryRow>(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, run_id, event_type, status, attempt_count, max_attempts, next_retry_at, created_at)
     VALUES ($1, $2, NULL, $3, 'PENDING', 0, 1, NULL, NOW())
     RETURNING *`,
    [deliveryId, webhook.id, eventType]
  );
  const initial = baseInsert.rows[0]!;

  if (isPrivateUrl(webhook.request_url)) {
    const failed = await query<DeliveryRow>(
      `UPDATE webhook_deliveries
       SET status = 'FAILED', attempt_count = 1,
           response_body = 'Webhook URL targets a private/internal network address',
           finished_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [deliveryId]
    );
    return failed.rows[0] ?? initial;
  }

  // Derive `status` from the eventType so the synthetic run mirrors what
  // production would produce for a real run reaching this state. Production
  // event format is `ACTOR.RUN.${status}` (SUCCEEDED, FAILED, TIMED-OUT,
  // ABORTED), so the last segment is the status. Falls back to SUCCEEDED
  // for non-ACTOR.RUN events (future-proofing).
  const statusFromEventType = eventType.split('.').pop() ?? 'SUCCEEDED';

  // Synthetic run with realistic timing/IDs so receivers can exercise their
  // full parsing path. `test-` prefixed IDs let receivers tell test runs
  // apart from production at the data layer (in addition to `payload.test`).
  const startedAt = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago
  const finishedAt = ['RUNNING', 'READY'].includes(statusFromEventType) ? null : now;
  const exitCode =
    statusFromEventType === 'SUCCEEDED' ? 0 : statusFromEventType === 'RUNNING' ? null : 1;
  const syntheticRun: WebhookRun = {
    id: testRunId,
    actorId: `test-${webhook.actor_id ?? 'actor'}`,
    userId: webhook.user_id,
    status: statusFromEventType,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt ? finishedAt.toISOString() : null,
    defaultDatasetId: `test-dataset-${deliveryId}`,
    defaultKeyValueStoreId: `test-kv-${deliveryId}`,
    defaultRequestQueueId: `test-rq-${deliveryId}`,
    timeoutSecs: 3600,
    memoryMbytes: 1024,
    buildId: `test-build-${deliveryId}`,
    buildNumber: '0.0.1',
    exitCode,
    stats: {
      inputBodyLen: 0,
      restartCount: 0,
      resurrectCount: 0,
      runTimeSecs: finishedAt ? Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000) : 0,
      computeUnits: 0,
    },
  };
  // Apply the user's payload_template if set, so test webhooks exercise
  // the same engine production deliveries do. Without this, an operator
  // could test a webhook successfully and find their custom template
  // mangling production payloads.
  const defaultPayload = buildWebhookPayload(eventType, syntheticRun, { test: true });
  const payload = applyWebhookTemplate(
    webhook.payload_template,
    defaultPayload as unknown as Record<string, unknown>
  );
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(webhook.headers ?? {}),
  };

  let responseStatus: number | null = null;
  let responseBody = '';
  let ok = false;

  try {
    const response = await fetch(webhook.request_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    responseStatus = response.status;
    responseBody = (await response.text().catch(() => '')).slice(0, 1024);
    ok = response.ok;
  } catch (err) {
    responseBody = (err as Error).message.slice(0, 1024);
  }

  const finalStatus = ok ? 'DELIVERED' : 'FAILED';
  const updated = await query<DeliveryRow>(
    `UPDATE webhook_deliveries
     SET status = $1, attempt_count = 1,
         response_status = $2, response_body = $3,
         finished_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [finalStatus, responseStatus, responseBody, deliveryId]
  );
  return updated.rows[0] ?? initial;
}

function formatWebhook(row: WebhookRow) {
  return {
    id: row.id,
    userId: row.user_id,
    eventTypes: row.event_types,
    requestUrl: row.request_url,
    payloadTemplate: row.payload_template,
    actorId: row.actor_id,
    headers: row.headers,
    description: row.description,
    isEnabled: row.is_enabled,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

function formatDelivery(row: DeliveryRow) {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    runId: row.run_id,
    eventType: row.event_type,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextRetryAt: row.next_retry_at,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}
