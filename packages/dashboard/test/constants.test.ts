/**
 * Tests for the dashboard's compile-time constants — mostly guarding
 * that APP_VERSION tracks package.json instead of drifting against a
 * hardcoded label, and that tunables stay in sane ranges.
 */
import { describe, it, expect } from 'vitest';
import packageJson from '../package.json';
import {
  APP_VERSION,
  PAGE_SIZE,
  FETCH_ALL_LIMIT,
  LOG_TAIL_LIMIT,
  DATASET_PREVIEW_LIMIT,
  KV_KEYS_PREVIEW_LIMIT,
  POLL_RETENTION_MS,
  POLL_RUNNERS_MS,
  COPY_FEEDBACK_MS,
} from '@/lib/constants';

describe('constants', () => {
  it('APP_VERSION is sourced from package.json', () => {
    expect(APP_VERSION).toBe(packageJson.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('list page size stays within the API page cap', () => {
    expect(PAGE_SIZE).toBeGreaterThan(0);
    expect(PAGE_SIZE).toBeLessThanOrEqual(FETCH_ALL_LIMIT);
  });

  it('preview limits are positive and bounded', () => {
    for (const limit of [LOG_TAIL_LIMIT, DATASET_PREVIEW_LIMIT, KV_KEYS_PREVIEW_LIMIT]) {
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(FETCH_ALL_LIMIT);
    }
  });

  it('polling cadences are at least a second so pages cannot hot-loop the API', () => {
    expect(POLL_RETENTION_MS).toBeGreaterThanOrEqual(1000);
    expect(POLL_RUNNERS_MS).toBeGreaterThanOrEqual(1000);
    expect(COPY_FEEDBACK_MS).toBeGreaterThan(0);
  });
});
