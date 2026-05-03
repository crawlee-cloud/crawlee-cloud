/**
 * S3-compatible storage for datasets and key-value store records.
 * Works with AWS S3, MinIO, DigitalOcean Spaces, Cloudflare R2, etc.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export let s3: S3Client;

export async function initS3(): Promise<void> {
  s3 = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3SecretKey,
    },
    forcePathStyle: config.s3ForcePathStyle,
  });

  console.log('S3 client initialized');
}

/**
 * Store a single dataset item.
 *
 * Retained for backwards compatibility with any existing caller; the dataset
 * push route now uses putDatasetBatch (one S3 object per pushData call) for
 * cost on Spaces and IOPS on hobby MinIO. Reads transparently handle both
 * formats — see iterateDatasetItems.
 */
export async function putDatasetItem(
  datasetId: string,
  itemIndex: number,
  data: unknown
): Promise<void> {
  const key = `datasets/${datasetId}/${String(itemIndex).padStart(9, '0')}.json`;

  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: 'application/json',
    })
  );
}

/**
 * Store a batch of dataset items as a single S3 object.
 *
 * Key shape: `datasets/{id}/{startIdx-9d}.batch.json`. The 9-digit padding on
 * startIdx preserves lexicographic = numeric ordering relative to the legacy
 * `{idx-9d}.json` key shape, so a single ListObjectsV2 returns old + new keys
 * interleaved in correct numeric order. The `.batch.json` infix is the
 * positive marker iterateDatasetItems dispatches on.
 */
export async function putDatasetBatch(
  datasetId: string,
  startIdx: number,
  items: unknown[]
): Promise<void> {
  if (items.length === 0) return;
  const key = `datasets/${datasetId}/${String(startIdx).padStart(9, '0')}.batch.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: JSON.stringify(items),
      ContentType: 'application/json',
    })
  );
}

/**
 * Get dataset items with pagination — skips whole batch objects by
 * filename without fetching their bodies.
 *
 * Strategy: list every key once (paginated ListObjectsV2 walk; cheap),
 * derive each key's [start, length) range from the filename, filter to
 * ranges overlapping the requested [offset, offset + limit) window,
 * then GET only those keys in parallel.
 *
 * For batched keys (`{startIdx-9d}.batch.json`), length is inferred as
 * the next key's startIdx minus this one's. For the last key, length
 * comes from caller-supplied `total` (datasets.item_count) or defaults
 * to 1. For legacy single-item keys (`{idx-9d}.json`), length is 1.
 *
 * Cost: O(total / 1000) LIST + O(ceil(limit / batch_size) + 1) GET.
 * The previous read-from-zero implementation was O(offset / batch_size)
 * GETs at deep offsets — this one is bounded by `limit` regardless of
 * how deep the offset goes.
 *
 * `total`: caller should pass `datasets.item_count` (authoritative).
 * When omitted, falls back to the last key's inferred range.
 */
export async function listDatasetItems(
  datasetId: string,
  options: { offset?: number; limit?: number; total?: number } = {}
): Promise<{ items: unknown[]; total: number }> {
  const { offset = 0, limit = 100, total: totalHint } = options;
  const wantStart = offset;
  const wantEnd = offset + limit;

  // Phase 1: collect keys + their inferred ranges. No body fetches.
  const keys: string[] = [];
  for await (const key of iterateDatasetKeys(datasetId)) {
    keys.push(key);
  }
  if (keys.length === 0) return { items: [], total: totalHint ?? 0 };

  const startOf = (key: string): number => {
    const m = /(\d{9})/.exec(key);
    return m ? parseInt(m[1]!, 10) : 0;
  };

  type Range = { key: string; start: number; length: number; isBatch: boolean };
  const ranges: Range[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const start = startOf(key);
    const isBatch = key.endsWith('.batch.json');
    let length: number;
    if (!isBatch) {
      length = 1;
    } else if (i + 1 < keys.length) {
      length = startOf(keys[i + 1]!) - start;
    } else {
      // Last batch — derive length from caller-supplied total when known,
      // otherwise default to 1 (under-counts the tail; callers that need
      // exact pagination across the last batch should pass `total`).
      length = totalHint !== undefined ? Math.max(1, totalHint - start) : 1;
    }
    if (length > 0) ranges.push({ key, start, length, isBatch });
  }

  // Phase 2: filter to ranges overlapping [wantStart, wantEnd).
  const overlapping = ranges.filter((r) => r.start < wantEnd && r.start + r.length > wantStart);

  // Phase 3: parallel-fetch only the overlapping keys.
  const fetched = await Promise.all(
    overlapping.map(async (r) => {
      const body = await getDatasetItemByKey(r.key);
      const arr = r.isBatch ? (Array.isArray(body) ? body : []) : [body];
      return { range: r, items: arr };
    })
  );

  // Phase 4: place items at their absolute positions, then slice. Using a
  // Map keeps the result dense even if a batch turns out shorter than its
  // inferred length (e.g. an unfinished tail).
  const placed = new Map<number, unknown>();
  for (const { range, items: chunkItems } of fetched) {
    for (let i = 0; i < chunkItems.length; i++) {
      const absIdx = range.start + i;
      if (absIdx >= wantStart && absIdx < wantEnd) {
        placed.set(absIdx, chunkItems[i]);
      }
    }
  }
  const items: unknown[] = [];
  for (let i = wantStart; i < wantEnd; i++) {
    if (placed.has(i)) items.push(placed.get(i));
  }

  const lastRange = ranges[ranges.length - 1];
  const derivedTotal = lastRange ? lastRange.start + lastRange.length : 0;
  return { items, total: totalHint ?? derivedTotal };
}

/**
 * Store a key-value record.
 */
export async function putKVRecord(
  storeId: string,
  key: string,
  data: Buffer | string,
  contentType: string
): Promise<void> {
  const s3Key = `key-value-stores/${storeId}/${encodeURIComponent(key)}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: s3Key,
      Body: typeof data === 'string' ? data : data,
      ContentType: contentType,
    })
  );
}

/**
 * Get a key-value record.
 */
export async function getKVRecord(
  storeId: string,
  key: string
): Promise<{ value: Buffer; contentType: string } | null> {
  const s3Key = `key-value-stores/${storeId}/${encodeURIComponent(key)}`;

  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: config.s3Bucket,
        Key: s3Key,
      })
    );

    const body = await result.Body?.transformToByteArray();
    if (!body) return null;

    return {
      value: Buffer.from(body),
      contentType: result.ContentType || 'application/octet-stream',
    };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'NoSuchKey') return null;
    throw err;
  }
}

/**
 * Async-iterate over every dataset item key, transparently following S3's
 * continuation token. The existing listDatasetItems silently caps at ~1000
 * items because ListObjectsV2 returns at most that per call without paging;
 * downloads must NOT cap silently.
 */
export async function* iterateDatasetKeys(datasetId: string): AsyncGenerator<string> {
  const prefix = `datasets/${datasetId}/`;
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.s3Bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of result.Contents ?? []) {
      if (obj.Key) yield obj.Key;
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * Fetch one dataset item by S3 key. Used by the streaming download endpoint
 * which iterates keys, then fetches with bounded concurrency.
 *
 * Note: this returns the *raw* contents of the S3 object — for `.batch.json`
 * keys that's a JSON array, for legacy `{idx}.json` keys that's a single
 * value. Most callers should prefer iterateDatasetItems, which dispatches by
 * key shape and yields one item at a time.
 */
export async function getDatasetItemByKey(key: string): Promise<unknown> {
  const result = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
  const body = await result.Body?.transformToString();
  return body ? JSON.parse(body) : null;
}

/**
 * Async-iterate over every dataset item, transparently handling both the
 * legacy per-item key shape (`{idx-9d}.json`) and the batched key shape
 * (`{startIdx-9d}.batch.json` containing a JSON array).
 *
 * Items are yielded in numeric index order across both formats — the 9-digit
 * zero-padding on both shapes ensures lexicographic listing == numeric order.
 *
 * Use this for any read path that needs item-level iteration. The lower-level
 * iterateDatasetKeys + getDatasetItemByKey are still exported for callers
 * that want raw key-level control (e.g. parallel fetch with custom batching),
 * but those callers must dispatch on the `.batch.json` suffix themselves.
 */
export async function* iterateDatasetItems(datasetId: string): AsyncGenerator<unknown> {
  for await (const key of iterateDatasetKeys(datasetId)) {
    const body = await getDatasetItemByKey(key);
    if (key.endsWith('.batch.json')) {
      if (Array.isArray(body)) {
        for (const item of body) yield item;
      } else {
        // Malformed batch object: skip rather than crash a download
        // mid-stream, but emit a server log so operators see the
        // integrity issue instead of inheriting a silent gap. A
        // non-array body in a .batch.json key indicates a writer that
        // bypassed putDatasetBatch — worth investigating.
        console.error(
          `[dataset] malformed batch object at ${key} (body is ${typeof body}, not Array); skipped`
        );
      }
    } else {
      yield body;
    }
  }
}

/**
 * Generate a time-limited URL the browser can fetch directly from S3 — no
 * API server pass-through. Used for "View raw" / "Download" buttons on KV
 * records, where each record is exactly one S3 object.
 *
 * Returns null if the record doesn't exist (mirrors getKVRecord's contract).
 *
 * The expiresIn ceiling is 7 days per AWS SigV4; we cap at 1 hour to keep
 * any leaked URL short-lived.
 */
export async function presignKVRecord(
  storeId: string,
  key: string,
  expiresIn = 3600
): Promise<{ url: string; expiresAt: string } | null> {
  const s3Key = `key-value-stores/${storeId}/${encodeURIComponent(key)}`;

  // HEAD first so we can return null cleanly for missing keys instead of
  // handing back a presigned URL that 404s.
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: s3Key }));
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'NotFound' || name === 'NoSuchKey') return null;
    throw err;
  }

  const ttl = Math.min(3600, Math.max(60, expiresIn));
  // ResponseContentDisposition becomes the special `response-content-disposition`
  // query param on the presigned URL — S3/MinIO honours it at GET time.
  // We force bare `inline` (NO filename hint) so browsers default to rendering
  // the response in a tab. Any `filename=` parameter — even with `inline` —
  // triggers download behavior in Chromium/Playwright. Operators wanting to
  // save can Cmd-S / Ctrl-S from the rendered tab.
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.s3Bucket,
      Key: s3Key,
      ResponseContentDisposition: 'inline',
    }),
    { expiresIn: ttl }
  );
  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
}

/**
 * Delete a key-value record.
 */
export async function deleteKVRecord(storeId: string, key: string): Promise<void> {
  const s3Key = `key-value-stores/${storeId}/${encodeURIComponent(key)}`;

  await s3.send(
    new DeleteObjectCommand({
      Bucket: config.s3Bucket,
      Key: s3Key,
    })
  );
}

/**
 * Check if a key-value record exists.
 */
export async function kvRecordExists(storeId: string, key: string): Promise<boolean> {
  const s3Key = `key-value-stores/${storeId}/${encodeURIComponent(key)}`;

  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: config.s3Bucket,
        Key: s3Key,
      })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * List all keys in a key-value store.
 */
export async function listKVKeys(
  storeId: string,
  options: { limit?: number; exclusiveStartKey?: string } = {}
): Promise<{
  keys: { key: string; size: number }[];
  isTruncated: boolean;
  nextExclusiveStartKey?: string;
}> {
  const { limit = 100, exclusiveStartKey } = options;
  const prefix = `key-value-stores/${storeId}/`;

  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: config.s3Bucket,
      Prefix: prefix,
      MaxKeys: limit,
      StartAfter: exclusiveStartKey
        ? `${prefix}${encodeURIComponent(exclusiveStartKey)}`
        : undefined,
    })
  );

  const keys = (result.Contents || []).map((obj) => ({
    key: decodeURIComponent(obj.Key!.replace(prefix, '')),
    size: obj.Size || 0,
  }));

  return {
    keys,
    isTruncated: result.IsTruncated || false,
    nextExclusiveStartKey: keys.length > 0 ? keys[keys.length - 1]!.key : undefined,
  };
}

/**
 * Bulk-delete every object under a prefix. Paginates ListObjectsV2 and
 * issues DeleteObjects (S3-side cap of 1000 keys/request). Used by the
 * retention reaper to clean unnamed-dataset and unnamed-KV S3 prefixes
 * after the corresponding PG row has been deleted.
 *
 * Idempotent: empty prefixes are a no-op. S3 errors propagate; callers
 * are expected to catch and log so a single failed bucket-wide delete
 * doesn't abort the rest of a reaper phase.
 */
async function deleteByPrefix(prefix: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.s3Bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const keys = (listed.Contents ?? [])
      .filter((o): o is typeof o & { Key: string } => typeof o.Key === 'string')
      .map((o) => ({ Key: o.Key }));
    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: config.s3Bucket,
          Delete: { Objects: keys, Quiet: true },
        })
      );
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

export async function deleteDatasetS3Prefix(datasetId: string): Promise<void> {
  await deleteByPrefix(`datasets/${datasetId}/`);
}

export async function deleteKVStoreS3Prefix(storeId: string): Promise<void> {
  await deleteByPrefix(`key-value-stores/${storeId}/`);
}
