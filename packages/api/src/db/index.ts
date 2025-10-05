/**
 * PostgreSQL database initialization and connection.
 */

import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export let pool: pg.Pool;

export async function initDatabase(): Promise<void> {
  pool = new Pool({
    connectionString: config.databaseUrl,
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
