/**
 * Config validation tests. Each test isolates env state then dynamically
 * imports config.ts so the validators run on the test's env values.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Reset to a clean baseline for each test.
  process.env = { ...ORIGINAL_ENV };
  // Clear all retention vars so defaults apply unless the test sets them.
  delete process.env.RETENTION_ENABLED;
  delete process.env.RETENTION_DAYS;
  delete process.env.RETENTION_TOMBSTONE_DAYS;
  delete process.env.RETENTION_BATCH_SIZE;
  delete process.env.RETENTION_CRON;
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('config — retention defaults', () => {
  it('applies defaults when env vars are unset', async () => {
    const { config } = await import('../src/config.js');
    expect(config.retentionEnabled).toBe(true);
    expect(config.retentionDays).toBe(30);
    expect(config.retentionTombstoneDays).toBe(365);
    expect(config.retentionBatchSize).toBe(500);
    expect(config.retentionCron).toBe('0 3 * * *');
  });

  it('reads env-supplied values when set', async () => {
    process.env.RETENTION_ENABLED = 'false';
    process.env.RETENTION_DAYS = '7';
    process.env.RETENTION_TOMBSTONE_DAYS = '90';
    process.env.RETENTION_BATCH_SIZE = '1000';
    process.env.RETENTION_CRON = '0 */6 * * *';
    const { config } = await import('../src/config.js');
    expect(config.retentionEnabled).toBe(false);
    expect(config.retentionDays).toBe(7);
    expect(config.retentionTombstoneDays).toBe(90);
    expect(config.retentionBatchSize).toBe(1000);
    expect(config.retentionCron).toBe('0 */6 * * *');
  });
});

describe('config — retention validation', () => {
  it('rejects RETENTION_DAYS=0', async () => {
    process.env.RETENTION_DAYS = '0';
    await expect(import('../src/config.js')).rejects.toThrow(/RETENTION_DAYS/);
  });

  it('rejects negative RETENTION_BATCH_SIZE', async () => {
    process.env.RETENTION_BATCH_SIZE = '-5';
    await expect(import('../src/config.js')).rejects.toThrow(/RETENTION_BATCH_SIZE/);
  });

  it('rejects invalid RETENTION_CRON expression', async () => {
    process.env.RETENTION_CRON = 'not a cron expression';
    await expect(import('../src/config.js')).rejects.toThrow(/RETENTION_CRON/);
  });

  it('accepts valid five-field RETENTION_CRON', async () => {
    process.env.RETENTION_CRON = '*/15 * * * *';
    const { config } = await import('../src/config.js');
    expect(config.retentionCron).toBe('*/15 * * * *');
  });
});
