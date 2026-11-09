/**
 * Keep pg pools and Redis clients from crashing the runner on connection
 * errors.
 *
 * Both are EventEmitters that emit 'error' when the server drops a
 * connection (pg_terminate_backend, Postgres failover or restart, Redis
 * restart). Node throws an 'error' event that has no listener, which kills
 * the process. pg-pool discards a broken idle client, a broken checked-out
 * client fails its next query and is discarded on release, and ioredis
 * reconnects on its own, so logging is all that's needed.
 */
import type pg from 'pg';

interface ErrorEmitter {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export function logClientErrors<T extends ErrorEmitter>(client: T, label: string): T {
  client.on('error', (err: Error) => {
    console.error(`[${label}] connection error: ${err.message}`);
  });
  return client;
}

/**
 * Log errors from a pg Pool and from every client it opens. The pool emits
 * 'error' for idle clients; a checked-out client emits on itself.
 */
export function logPoolErrors(pool: pg.Pool, label: string): pg.Pool {
  logClientErrors(pool, label);
  pool.on('connect', (client) => {
    logClientErrors(client, label);
  });
  return pool;
}
