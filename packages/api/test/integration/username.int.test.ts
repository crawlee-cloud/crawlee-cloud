import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  createTestApp,
  runMigrations,
  createTestUser,
  cleanDatabase,
  ensureS3Bucket,
} from './setup.js';
import { USERNAME_CASES, USERNAME_PATTERN } from '../username-cases.js';

describe('Username slug (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await ensureS3Bucket();
    app = await createTestApp();
    await runMigrations();
  });

  afterEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v2/users/me returns the username slug and the email separately', async () => {
    const { token } = await createTestUser('me-test@integration.local');
    const res = await app.inject({
      method: 'GET',
      url: '/v2/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { username: string; email: string };
    expect(data.username).toMatch(USERNAME_PATTERN);
    expect(data.username.length).toBeLessThanOrEqual(30);
    expect(data.email).toBe('me-test@integration.local');
  });

  it('GET /v2/auth/me includes the username', async () => {
    const { token } = await createTestUser('auth-me@integration.local', 'pw123456', 'auth-me');
    const res = await app.inject({
      method: 'GET',
      url: '/v2/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      email: 'auth-me@integration.local',
      username: 'auth-me',
    });
  });

  it('setupAdminUser gives the default admin@crawlee.cloud the username admin', async () => {
    const { config } = await import('../../src/config.js');
    const { setupAdminUser } = await import('../../src/setup.js');
    const { pool } = await import('../../src/db/index.js');
    const saved = { email: config.adminEmail, password: config.adminPassword };
    config.adminEmail = 'admin@crawlee.cloud';
    config.adminPassword = 'admin-password-123';
    try {
      await setupAdminUser();
    } finally {
      config.adminEmail = saved.email;
      config.adminPassword = saved.password;
    }
    const row = await pool.query<{ username: string; role: string }>(
      'SELECT username, role FROM users WHERE email = $1',
      ['admin@crawlee.cloud']
    );
    expect(row.rows[0]).toEqual({ username: 'admin', role: 'admin' });
  });

  it('a duplicate username fails on users_username_key (the retry relies on it)', async () => {
    const { pool } = await import('../../src/db/index.js');
    await createTestUser('dup-1@integration.local', 'pw123456', 'dup');
    const err = await createTestUser('dup-2@integration.local', 'pw123456', 'dup').catch(
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: '23505', constraint: 'users_username_key' });
    const nullErr = await pool
      .query(`INSERT INTO users (id, email, password_hash) VALUES ('nulluser', 'n@x.com', 'h')`)
      .catch((e: unknown) => e);
    expect(nullErr).toMatchObject({ code: '23502' });
  });
});

/**
 * Runs the real migration SQL against a scratch database, so a legacy
 * users table (no username column) can be set up and backfilled without
 * touching the shared test database.
 */
describe('Username migration backfill (integration)', () => {
  const baseUrl = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/crawlee_test';
  const dbName = `username_backfill_${process.pid}_${Date.now()}`;
  let admin: pg.Client;
  let client: pg.Client;
  let schema: string;

  beforeAll(async () => {
    ({ schema } = await import('../../src/db/migrate.js'));
    admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(baseUrl);
    url.pathname = `/${dbName}`;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it('backfills existing users in created_at order, matching generateUsername', async () => {
    // users table as it existed before #110.
    await client.query(`
      CREATE TABLE users (
        id VARCHAR(21) PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        role TEXT DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        modified_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Insert in reverse so created_at order, not insertion order, decides
    // who gets the unsuffixed name.
    for (let i = USERNAME_CASES.length - 1; i >= 0; i--) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, created_at)
         VALUES ($1, $2, 'h', TIMESTAMPTZ '2026-01-01' + $3 * INTERVAL '1 second')`,
        [`u${i}`, USERNAME_CASES[i].email, i]
      );
    }

    await client.query(schema);

    const rows = await client.query<{ id: string; username: string }>(
      'SELECT id, username FROM users'
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.username]));
    USERNAME_CASES.forEach(({ email, expected }, i) => {
      expect(byId.get(`u${i}`), email).toBe(expected);
    });

    const col = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'username'`
    );
    expect(col.rows[0]?.is_nullable).toBe('NO');
  });

  it('rerunning the migration is a no-op', async () => {
    const before = await client.query('SELECT id, username FROM users ORDER BY id');
    await client.query(schema);
    const after = await client.query('SELECT id, username FROM users ORDER BY id');
    expect(after.rows).toEqual(before.rows);
  });
});
