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

describe('config-validator — PROXY_ENCRYPTION_KEY', () => {
  async function runValidator() {
    const { validateSecurityConfig } = await import('../src/config-validator.js');
    return validateSecurityConfig();
  }

  // In production mode, config.ts disables dev defaults — every required env
  // var must be set or it throws during import. Set the minimum here so the
  // validator can actually run.
  function setProductionEnv() {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/test';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    process.env.S3_ACCESS_KEY = 'k';
    process.env.S3_SECRET_KEY = 's';
    process.env.S3_BUCKET = 'b';
    process.env.S3_REGION = 'us-east-1';
    process.env.API_SECRET = 'x'.repeat(64);
    process.env.CORS_ORIGINS = 'https://example.com';
  }

  it('errors in production when PROXY_ENCRYPTION_KEY is absent', async () => {
    setProductionEnv();
    delete process.env.PROXY_ENCRYPTION_KEY;
    const result = await runValidator();
    expect(result.errors.some((e) => e.includes('PROXY_ENCRYPTION_KEY must be set'))).toBe(true);
  });

  it('warns in development when PROXY_ENCRYPTION_KEY is absent', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.PROXY_ENCRYPTION_KEY;
    const result = await runValidator();
    expect(result.errors.some((e) => e.includes('PROXY_ENCRYPTION_KEY'))).toBe(false);
  });

  it('errors when PROXY_ENCRYPTION_KEY has wrong length', async () => {
    process.env.NODE_ENV = 'development';
    process.env.PROXY_ENCRYPTION_KEY = 'tooshort';
    const result = await runValidator();
    const msg = [...result.errors, ...result.warnings].find((m) =>
      m.includes('PROXY_ENCRYPTION_KEY must be exactly 64 hex')
    );
    expect(msg).toBeDefined();
  });

  it('errors when PROXY_ENCRYPTION_KEY is 64 chars but not hex', async () => {
    // 64-char garbage would otherwise pass a naive length check and silently
    // truncate at Buffer.from(s, 'hex'). The hex regex must reject it.
    process.env.NODE_ENV = 'development';
    process.env.PROXY_ENCRYPTION_KEY = 'z'.repeat(64);
    const result = await runValidator();
    const msg = [...result.errors, ...result.warnings].find((m) =>
      m.includes('PROXY_ENCRYPTION_KEY must be exactly 64 hex')
    );
    expect(msg).toBeDefined();
  });

  it('passes when PROXY_ENCRYPTION_KEY is 64 hex chars in production', async () => {
    setProductionEnv();
    process.env.PROXY_ENCRYPTION_KEY = 'a'.repeat(64);
    const result = await runValidator();
    const proxyMsg = [...result.errors, ...result.warnings].find((m) =>
      m.includes('PROXY_ENCRYPTION_KEY')
    );
    expect(proxyMsg).toBeUndefined();
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
