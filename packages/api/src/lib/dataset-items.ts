/**
 * Shared read path for dataset items — `GET /v2/datasets/:id/items` and the
 * run-scoped `GET /v2/actor-runs/:runId/dataset/items` both delegate here so
 * the two routes can't drift apart on pagination, ordering or projection.
 *
 * Supported query parameters (Apify parity):
 *   offset, limit  pagination; omitting `limit` streams the whole dataset
 *   desc=1|true    newest first; `offset` then counts from the end
 *   download=1     whole dataset as a JSON attachment
 *   fields=a,b     keep only these top-level keys, in this order
 *   omit=a,b       drop these top-level keys (applied after `fields`)
 *   flatten        accepted and ignored (not implemented yet)
 *
 * Empty `fields` / `omit` / `flatten` are treated as absent: apify-client
 * serializes an unset array option as an empty string (`fields=&omit=`),
 * and the MCP server always sends them.
 *
 * Projection runs on items after they're read from S3 — storage reads are
 * the same with or without it.
 */

import type { FastifyReply } from 'fastify';
import { listDatasetItems, iterateDatasetItems } from '../storage/s3.js';
import { zBoolQuery } from '../schemas/common.js';

export interface DatasetItemsQuery {
  offset?: string;
  limit?: string;
  desc?: string;
  download?: string;
  // Repeated params (`fields=a&fields=b`) arrive as an array.
  fields?: string | string[];
  omit?: string | string[];
  flatten?: string | string[];
}

/** Dataset identity plus its authoritative `datasets.item_count`. */
export interface DatasetRef {
  id: string;
  /** Null when the datasets row is missing (run-scoped LEFT JOIN). */
  itemCount: number | null;
}

/**
 * Boolean query flag via the shared zBoolQuery (`1`/`0`/`true`/`false`;
 * anything else is a 400 validation_error). Absent or empty is false: like
 * `fields=`, apify-client may serialize an unset flag as an empty string.
 */
export function isTrueQuery(value: string | undefined): boolean {
  return zBoolQuery.parse(value === '' ? undefined : value) ?? false;
}

/** `a,b` / `['a', 'b,c']` → `['a', 'b', 'c']`; empty → undefined (absent). */
export function parseKeyList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const keys = (Array.isArray(value) ? value : [value])
    .flatMap((v) => v.split(','))
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return keys.length > 0 ? keys : undefined;
}

/**
 * Build the per-item projection for `fields` / `omit`, or null when neither
 * is set (callers skip the map entirely). Only plain objects are projected;
 * a non-object item (a bare string pushed via pushData) passes through.
 */
export function buildItemProjection(
  fields: string[] | undefined,
  omit: string[] | undefined
): ((item: unknown) => unknown) | null {
  if (!fields && !omit) return null;
  const omitSet = omit ? new Set(omit) : null;
  return (item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const src = item as Record<string, unknown>;
    let out: Record<string, unknown>;
    if (fields) {
      out = {};
      for (const f of fields) {
        if (Object.prototype.hasOwnProperty.call(src, f)) out[f] = src[f];
      }
    } else {
      out = { ...src };
    }
    if (omitSet) for (const k of omitSet) delete out[k];
    return out;
  };
}

/**
 * Serve dataset items for both items routes. Returns the item array for the
 * paginated branch; the two streaming branches write to `reply.raw` and
 * return `reply` (Fastify's signal that the response was already sent).
 */
export async function sendDatasetItems(
  reply: FastifyReply,
  dataset: DatasetRef,
  q: DatasetItemsQuery
): Promise<unknown> {
  const desc = isTrueQuery(q.desc);
  const project = buildItemProjection(parseKeyList(q.fields), parseKeyList(q.omit));
  const serialize = (item: unknown) => JSON.stringify(project ? project(item) : item);

  // ?download=1 — stream the FULL dataset as a single JSON array file.
  // Browser opens it as a download; no in-memory materialization on either
  // server (sequential streaming via iterateDatasetItems) or client. This
  // sidesteps the silent ~1000-item cap in the legacy listDatasetItems and
  // the browser-blob memory pressure on the dashboard side.
  //
  // iterateDatasetItems handles both legacy per-item keys and the newer
  // batched keys transparently; one yielded item == one comma-separated
  // entry in the output array.
  if (isTrueQuery(q.download)) {
    // setHeader on the raw response — reply.header() needs Fastify's
    // lifecycle to flush, but streaming via reply.raw bypasses that.
    // First propagate Fastify-prepared headers (CORS from @fastify/cors,
    // etc.) so the browser doesn't reject the response.
    const stream = reply.raw;
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) stream.setHeader(k, v);
    }
    stream.setHeader('content-type', 'application/json; charset=utf-8');
    stream.setHeader('content-disposition', `attachment; filename="dataset-${dataset.id}.json"`);
    stream.write('[');

    let firstWritten = false;
    for await (const item of iterateDatasetItems(dataset.id, { reverse: desc })) {
      stream.write((firstWritten ? ',' : '') + serialize(item));
      firstWritten = true;
    }

    stream.write(']');
    stream.end();
    return reply;
  }

  // Apify parity: when `limit` is omitted, return the FULL dataset — real
  // Apify has no implicit page size, and clients built against it assume
  // that (a consumer paginating "like Apify" without an explicit limit got
  // silently capped at 100 items here). Streams via iterateDatasetItems
  // like the download branch — no in-memory materialization — but as a
  // plain JSON response: no attachment disposition, and Apify-style
  // pagination headers so clients can verify completeness.
  //
  // With desc, iteration runs newest-first, so skipping `offset` items
  // skips from the end — Apify's desc+offset semantics.
  if (q.limit === undefined) {
    const total = dataset.itemCount ?? 0;
    const fullOffset = Math.max(0, parseInt(q.offset || '0', 10) || 0);

    const stream = reply.raw;
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) stream.setHeader(k, v);
    }
    stream.setHeader('content-type', 'application/json; charset=utf-8');
    stream.setHeader('x-apify-pagination-total', String(total));
    stream.setHeader('x-apify-pagination-offset', String(fullOffset));
    stream.setHeader('x-apify-pagination-limit', String(Math.max(0, total - fullOffset)));
    stream.write('[');

    let skipped = 0;
    let firstWritten = false;
    for await (const item of iterateDatasetItems(dataset.id, { reverse: desc })) {
      if (skipped < fullOffset) {
        skipped++;
        continue;
      }
      stream.write((firstWritten ? ',' : '') + serialize(item));
      firstWritten = true;
    }

    stream.write(']');
    stream.end();
    return reply;
  }

  const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);
  const limit = Math.min(1000, Math.max(1, parseInt(q.limit || '100', 10) || 100));

  // Pass total = dataset.item_count so listDatasetItems can short-circuit
  // iteration once `limit` items have been collected. The DB row is the
  // authoritative count (incremented atomically on each push); deriving
  // total from S3 listing is what gave the legacy implementation its
  // silent 1000-item cap.
  const totalHint = dataset.itemCount ?? undefined;
  let items: unknown[];
  let total: number;
  if (desc) {
    // Newest first: `offset` counts from the end, so the page is the
    // forward window [total - offset - limit, total - offset), reversed.
    const end = Math.max(0, (totalHint ?? 0) - offset);
    const start = Math.max(0, end - limit);
    if (end === start) {
      items = [];
      total = totalHint ?? 0;
    } else {
      ({ items, total } = await listDatasetItems(dataset.id, {
        offset: start,
        limit: end - start,
        total: totalHint,
      }));
      items.reverse();
    }
  } else {
    ({ items, total } = await listDatasetItems(dataset.id, { offset, limit, total: totalHint }));
  }

  // Set pagination headers (Apify style) — the requested offset/limit,
  // whatever the direction.
  reply.header('x-apify-pagination-total', total);
  reply.header('x-apify-pagination-offset', offset);
  reply.header('x-apify-pagination-limit', limit);

  return project ? items.map(project) : items;
}
