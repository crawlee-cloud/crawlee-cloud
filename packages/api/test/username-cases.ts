/**
 * Shared input table for the username slug rules. Used by the unit tests
 * for generateUsername() (test/username.test.ts) and by the integration
 * test for the SQL backfill in migrate.ts
 * (test/integration/username.int.test.ts), which must agree — see the
 * KEEP-IN-SYNC note in src/auth/username.ts.
 *
 * Rows are allocated in order: each `expected` accounts for the usernames
 * taken by the rows above it.
 */
export const USERNAME_CASES: ReadonlyArray<{ email: string; expected: string }> = [
  // Default ADMIN_EMAIL: `admin` is not reserved.
  { email: 'admin@crawlee.cloud', expected: 'admin' },
  // Collision across domains.
  { email: 'alice@a.com', expected: 'alice' },
  { email: 'alice@b.com', expected: 'alice-2' },
  // Special characters collapse to single dashes; case is folded.
  { email: 'Alice.Smith+tag@example.com', expected: 'alice-smith-tag' },
  { email: '..weird__name..@x.io', expected: 'weird-name' },
  { email: 'José.Müller@x.de', expected: 'jos-m-ller' },
  { email: 'İstanbul@x.com', expected: 'stanbul' },
  { email: '"a@b"@x.com', expected: 'a-b' },
  { email: 'no-at-sign', expected: 'no-at-sign' },
  // Empty local part falls back to `user`.
  { email: '@nolocal.com', expected: 'user' },
  { email: '+++@x.com', expected: 'user-2' },
  { email: 'user@x.com', expected: 'user-3' },
  // Reserved names are treated as taken.
  { email: 'me@x.com', expected: 'me-2' },
  { email: 'API@x.com', expected: 'api-2' },
  { email: 'apify@x.com', expected: 'apify-2' },
  { email: 'system@x.com', expected: 'system-2' },
  // 40-character local part: truncated to 26, suffix still fits in 30.
  { email: `${'a'.repeat(40)}@x.com`, expected: 'a'.repeat(26) },
  { email: `${'a'.repeat(40)}@y.com`, expected: `${'a'.repeat(26)}-2` },
  { email: `${'a'.repeat(40)}@z.com`, expected: `${'a'.repeat(26)}-3` },
  // Truncation lands on a dash, which is trimmed.
  { email: 'abcdefghijklmnopqrstuvwxy-zzzz@x.com', expected: 'abcdefghijklmnopqrstuvwxy' },
];

export const USERNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
