/**
 * Security configuration validator.
 * Runs at startup to ensure secure configuration.
 *
 * Validates:
 * - API secret strength
 * - Known insecure default credentials
 * - CORS configuration
 */

import { config } from './config.js';
import constants from './security-constants.json' with { type: 'json' };

const WEAK_SECRETS: string[] = constants.weakSecrets;
const INSECURE_DB_PASSWORDS: string[] = constants.insecureDbPasswords;
const INSECURE_S3_CREDENTIALS: string[] = constants.insecureS3Credentials;

export interface SecurityValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate security configuration at startup.
 * In production, any error will prevent startup.
 * In development, warnings are logged but don't block.
 */
export function validateSecurityConfig(): SecurityValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProduction = config.nodeEnv === 'production';
  const report = (msg: string) => {
    if (isProduction) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  };

  // Validate API secret (exact match against known defaults)
  if (WEAK_SECRETS.some((weak) => config.apiSecret.toLowerCase() === weak.toLowerCase())) {
    report('API_SECRET is a known weak/default value');
  }

  if (config.apiSecret.length < 32) {
    report(`API_SECRET is too short (${config.apiSecret.length} chars, minimum 32 recommended)`);
  }

  // Proxy password encryption: production must use an explicit key. Dev
  // falls back to sha256(API_SECRET) — see proxy-crypto.ts.
  if (isProduction && !process.env.PROXY_ENCRYPTION_KEY) {
    report('PROXY_ENCRYPTION_KEY must be set in production (64 hex chars = 32 bytes)');
  }
  if (
    process.env.PROXY_ENCRYPTION_KEY &&
    !/^[0-9a-fA-F]{64}$/.test(process.env.PROXY_ENCRYPTION_KEY)
  ) {
    // Hex regex catches both wrong length AND non-hex chars in one check.
    // Buffer.from(s, 'hex') silently truncates at the first non-hex char,
    // so a 64-char garbage string would otherwise pass a naive .length === 64
    // check and break at runtime when the AES key buffer comes back < 32 bytes.
    report('PROXY_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }

  // Check database credentials
  const dbUrl = config.databaseUrl;
  for (const insecure of INSECURE_DB_PASSWORDS) {
    if (dbUrl.includes(`:${insecure}@`)) {
      report('DATABASE_URL contains a known insecure default password');
      break;
    }
  }

  // Check S3 credentials
  for (const insecure of INSECURE_S3_CREDENTIALS) {
    if (config.s3AccessKey === insecure || config.s3SecretKey === insecure) {
      report('S3 credentials contain a known insecure default value');
      break;
    }
  }

  // Validate CORS configuration
  if (!config.corsOrigins || config.corsOrigins.trim() === '') {
    report('CORS_ORIGINS is not configured');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Run security validation and handle results.
 * Throws in production if validation fails.
 * Logs warnings in development.
 */
export function enforceSecurityConfig(): void {
  const result = validateSecurityConfig();
  const isProduction = config.nodeEnv === 'production';

  // Log warnings
  for (const warning of result.warnings) {
    console.warn(`[SECURITY WARNING] ${warning}`);
  }

  // Handle errors
  if (!result.valid) {
    for (const error of result.errors) {
      console.error(`[SECURITY ERROR] ${error}`);
    }

    if (isProduction) {
      throw new Error(
        `Security validation failed with ${result.errors.length} error(s). ` +
          'Cannot start in production with insecure configuration.'
      );
    }
  }

  if (result.warnings.length === 0 && result.valid) {
    console.log('[OK] Security configuration validated');
  }
}
