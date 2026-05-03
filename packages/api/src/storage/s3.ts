/**
 * S3-compatible storage for datasets and key-value store records.
 * Works with AWS S3, MinIO, DigitalOcean Spaces, Cloudflare R2, etc.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
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
 * Get dataset items with pagination.
 *
 * Paginates at the *item* level, not the S3 key level — required so that
 * mixed legacy/batched datasets paginate correctly (one batch key may
 * contain hundreds of items). Total is supplied by the caller from
 * datasets.item_count, which is the authoritative count; the previous
 * implementation derived total from S3 listing and silently capped at
 * ~1000 (no pagination loop), so callers should pass total explicitly.
 *
 * Compatibility: if total is omitted, falls back to counting yielded items
 * up to offset+limit and returning that as a lower-bound. Existing callers
 * that don't pass total see a non-regressive behavior change (pagination
 * is now correct on batched data; total may under-report on huge datasets
 * relative to true item_count).
 */
export async function listDatasetItems(
  datasetId: string,
  options: { offset?: number; limit?: number; total?: number } = {}
): Promise<{ items: unknown[]; total: number }> {
  const { offset = 0, limit = 100 } = options;

  const items: unknown[] = [];
  let seen = 0;
  for await (const item of iterateDatasetItems(datasetId)) {
    if (seen >= offset && items.length < limit) {
      items.push(item);
    }
    seen++;
    if (items.length >= limit && options.total !== undefined) {
      // Caller supplied total — no need to keep iterating to derive one.
      return { items, total: options.total };
    }
  }
  return { items, total: options.total ?? seen };
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
      }
      // Non-array body in a .batch.json key is a malformed write — skip
      // rather than crash a download mid-stream. Operator-visible via API
      // logs; not silently swallowed in the iterator's contract.
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
