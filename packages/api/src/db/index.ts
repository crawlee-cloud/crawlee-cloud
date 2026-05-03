/**
 * PostgreSQL database initialization and connection.
 */

import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export let pool: pg.Pool;

export async function initDatabase(): Promise<void> {
  const useSSL = config.databaseUrl.includes('sslmode=') || config.nodeEnv === 'production';

  // Pool ceiling. Default 8 fits DO Managed PG 1GB plan (22-conn ceiling) with
  // headroom for migrations, runner pool, and admin sessions. Operators on
  // larger plans set DB_POOL_MAX explicitly per the deployment recipe; if a
  // PgBouncer/connection-pooler endpoint is in front of PG, set it high (50+)
  // and let the pooler multiplex.
  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
    max: parseInt(process.env.DB_POOL_MAX ?? '', 10) || 8,
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
