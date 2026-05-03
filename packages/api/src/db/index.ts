/**
 * PostgreSQL database initialization and connection.
 */

import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export let pool: pg.Pool;

export async function initDatabase(): Promise<void> {
  const useSSL = config.databaseUrl.includes('sslmode=') || config.nodeEnv === 'production';

  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
    max: config.dbPoolMax,
  });

  // Test connection
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('Database connected successfully');
  } finally {
    client.release();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

/**
 * Postgres advisory lock IDs registry. All advisory locks used in this
 * codebase MUST register their constant here so future additions can
 * pick non-colliding IDs.
 *
 * Note: values may exceed INT4_MAX (e.g. 0xC0DEBEEF). PG accepts them via
 * pg_try_advisory_lock's bigint overload — pick any 32-bit unsigned value.
 *
 *   0xC0DEBEEF  - retention reaper (packages/api/src/retention.ts)
 */
