/**
 * Tests for enforceSecurityConfig — the startup gate that turns security
 * findings into hard failures in production and warnings in development.
 * (validateSecurityConfig's individual checks are covered via the same
 * mutable config mock.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  nodeEnv: 'development',
  apiSecret: 'a-perfectly-long-and-unique-secret-value-123',
  databaseUrl: 'postgresql://user:s3curepw@db:5432/crawlee',
  s3AccessKey: 'real-access-key',
  s3SecretKey: 'real-secret-key',
  corsOrigins: 'https://app.example.com',
}));
vi.mock('../src/config.js', () => ({ config: mockConfig }));

import { validateSecurityConfig, enforceSecurityConfig } from '../src/config-validator.js';

const ORIGINAL_PROXY_KEY = process.env.PROXY_ENCRYPTION_KEY;

function secureBaseline() {
  mockConfig.nodeEnv = 'development';
  mockConfig.apiSecret = 'a-perfectly-long-and-unique-secret-value-123';
  mockConfig.databaseUrl = 'postgresql://user:s3curepw@db:5432/crawlee';
  mockConfig.s3AccessKey = 'real-access-key';
  mockConfig.s3SecretKey = 'real-secret-key';
  mockConfig.corsOrigins = 'https://app.example.com';
  process.env.PROXY_ENCRYPTION_KEY = 'ab'.repeat(32);
}

beforeEach(() => {
  secureBaseline();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  if (ORIGINAL_PROXY_KEY === undefined) delete process.env.PROXY_ENCRYPTION_KEY;
  else process.env.PROXY_ENCRYPTION_KEY = ORIGINAL_PROXY_KEY;
  vi.restoreAllMocks();
});

describe('validateSecurityConfig', () => {
  it('passes a secure configuration', () => {
    const result = validateSecurityConfig();
    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('downgrades findings to warnings outside production', () => {
    mockConfig.apiSecret = 'short';
    const result = validateSecurityConfig();
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('too short'))).toBe(true);
  });

  it('escalates the same findings to errors in production', () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.apiSecret = 'short';
    const result = validateSecurityConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('too short'))).toBe(true);
  });

  it('requires PROXY_ENCRYPTION_KEY in production', () => {
    mockConfig.nodeEnv = 'production';
    delete process.env.PROXY_ENCRYPTION_KEY;
    const result = validateSecurityConfig();
    expect(result.errors.some((e) => e.includes('PROXY_ENCRYPTION_KEY must be set'))).toBe(true);
  });

  it('rejects a malformed PROXY_ENCRYPTION_KEY in any environment', () => {
    process.env.PROXY_ENCRYPTION_KEY = 'not-hex';
    const result = validateSecurityConfig();
    expect(result.warnings.some((w) => w.includes('64 hex characters'))).toBe(true);
  });

  it('flags known-insecure database passwords and S3 credentials', () => {
    mockConfig.databaseUrl = 'postgresql://postgres:postgres@db:5432/crawlee';
    mockConfig.s3AccessKey = 'minioadmin';
    const result = validateSecurityConfig();
    expect(result.warnings.some((w) => w.includes('DATABASE_URL'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('S3 credentials'))).toBe(true);
  });

  it('flags missing CORS configuration', () => {
    mockConfig.corsOrigins = '  ';
    const result = validateSecurityConfig();
    expect(result.warnings.some((w) => w.includes('CORS_ORIGINS'))).toBe(true);
  });
});

describe('enforceSecurityConfig', () => {
  it('logs the all-clear when everything validates', () => {
    enforceSecurityConfig();
    expect(console.log).toHaveBeenCalledWith('[OK] Security configuration validated');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('logs warnings without throwing in development', () => {
    mockConfig.apiSecret = 'short';
    expect(() => enforceSecurityConfig()).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[SECURITY WARNING]'));
    expect(console.log).not.toHaveBeenCalledWith('[OK] Security configuration validated');
  });

  it('throws in production when validation fails, after logging each error', () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.apiSecret = 'short';
    mockConfig.corsOrigins = '';

    expect(() => enforceSecurityConfig()).toThrow(/Security validation failed with \d+ error/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[SECURITY ERROR]'));
  });

  it('does not throw for warnings-only findings outside production', () => {
    mockConfig.corsOrigins = '';
    expect(() => enforceSecurityConfig()).not.toThrow();
  });
});
