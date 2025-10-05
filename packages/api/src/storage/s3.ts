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
 * Store a dataset item.
 */
export async function putDatasetItem(
  datasetId: string, 
  itemIndex: number, 
  data: unknown
): Promise<void> {
  const key = `datasets/${datasetId}/${String(itemIndex).padStart(9, '0')}.json`;
  
  await s3.send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));
}

/**
 * Get dataset items with pagination.
 */
export async function listDatasetItems(
  datasetId: string,
  options: { offset?: number; limit?: number } = {}
): Promise<{ items: unknown[]; total: number }> {
  const { offset = 0, limit = 100 } = options;
  const prefix = `datasets/${datasetId}/`;
  
  // List all objects to get total count
  const listResult = await s3.send(new ListObjectsV2Command({
    Bucket: config.s3Bucket,
    Prefix: prefix,
  }));
  
  const allKeys = listResult.Contents?.map(obj => obj.Key!) || [];
  const total = allKeys.length;
  
  // Get subset based on offset/limit
  const keysToFetch = allKeys.slice(offset, offset + limit);
  
  const items = await Promise.all(
    keysToFetch.map(async (key) => {
      const result = await s3.send(new GetObjectCommand({
        Bucket: config.s3Bucket,
        Key: key,
      }));
      const body = await result.Body?.transformToString();
      return body ? JSON.parse(body) : null;
    })
  );
  
  return { items: items.filter(Boolean), total };
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
  
  await s3.send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: s3Key,
    Body: typeof data === 'string' ? data : data,
    ContentType: contentType,
  }));
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
    const result = await s3.send(new GetObjectCommand({
      Bucket: config.s3Bucket,
      Key: s3Key,
    }));
    
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
 * Delete a key-value record.
 */
export async function deleteKVRecord(storeId: string, key: string): Promise<void> {
  const s3Key = `key-value-stores/${storeId}/${encodeURIComponent(key)}`;
  
  await s3.send(new DeleteObjectCommand({
    Bucket: config.s3Bucket,
    Key: s3Key,
  }));
}

/**
 * Check if a key-value record exists.
 */
export async function kvRecordExists(storeId: string, key: string): Promise<boolean> {
  const s3Key = `key-value-stores/${storeId}/${encodeURIComponent(key)}`;
  
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: config.s3Bucket,
      Key: s3Key,
    }));
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
): Promise<{ keys: { key: string; size: number }[]; isTruncated: boolean; nextExclusiveStartKey?: string }> {
  const { limit = 100, exclusiveStartKey } = options;
  const prefix = `key-value-stores/${storeId}/`;
  
  const result = await s3.send(new ListObjectsV2Command({
    Bucket: config.s3Bucket,
    Prefix: prefix,
    MaxKeys: limit,
    StartAfter: exclusiveStartKey ? `${prefix}${encodeURIComponent(exclusiveStartKey)}` : undefined,
  }));
  
  const keys = (result.Contents || []).map(obj => ({
    key: decodeURIComponent(obj.Key!.replace(prefix, '')),
    size: obj.Size || 0,
  }));
  
  return {
    keys,
    isTruncated: result.IsTruncated || false,
    nextExclusiveStartKey: keys.length > 0 ? keys[keys.length - 1]!.key : undefined,
  };
}
