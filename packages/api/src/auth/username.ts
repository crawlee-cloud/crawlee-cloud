/**
 * Username slugs.
 *
 * Apify identifies actors as `username/name`, and the Apify MCP server
 * builds per-actor tool names from the username (`.` → `-dot-`). The
 * email cannot serve as one: `@` is rejected by MCP clients and LLM APIs
 * (common rule `^[a-zA-Z0-9_-]{1,64}$`). A username is therefore a slug
 * matching `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, at most 30 characters,
 * derived from the email's local part.
 *
 * KEEP-IN-SYNC: the backfill `DO $$` block at the end of the schema in
 * src/db/migrate.ts implements the same rules in SQL. Both are tested
 * against the same table of inputs (test/username.test.ts and
 * test/integration/username.int.test.ts).
 */

export const USERNAME_MAX_LENGTH = 30;

/** Base length that leaves room for a `-NNN` suffix within the max. */
const USERNAME_BASE_MAX_LENGTH = 26;

/**
 * Names that are never handed out. `admin` is deliberately not reserved:
 * the default ADMIN_EMAIL is admin@crawlee.cloud and the first admin
 * should get `admin`.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set(['me', 'api', 'apify', 'system']);

/**
 * Collision-free base derived from an email: local part, runs of anything
 * outside `[A-Za-z0-9]` collapsed to `-`, lowercased, `-` trimmed,
 * truncated to 26 characters and trimmed again; `user` when nothing is
 * left. (Replacing before lowercasing keeps the result identical to the
 * SQL backfill for non-ASCII input, whose case mapping differs between
 * JS and Postgres.)
 */
export function usernameBase(email: string): string {
  const at = email.lastIndexOf('@');
  const local = at === -1 ? email : email.slice(0, at);
  const slug = local
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '')
    .slice(0, USERNAME_BASE_MAX_LENGTH)
    .replace(/-+$/, '');
  return slug || 'user';
}

/**
 * The n-th candidate for a base: `base` for n = 1, then `base-2`,
 * `base-3`, ... The base is shortened when needed so the candidate never
 * exceeds USERNAME_MAX_LENGTH.
 */
export function usernameCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return base.slice(0, USERNAME_MAX_LENGTH - suffix.length).replace(/-+$/, '') + suffix;
}

/**
 * Generate a unique username for `email`. `exists` reports whether a
 * candidate is already taken; reserved names are treated as taken.
 */
export async function generateUsername(
  email: string,
  exists: (candidate: string) => boolean | Promise<boolean>
): Promise<string> {
  const base = usernameBase(email);
  for (let n = 1; ; n++) {
    const candidate = usernameCandidate(base, n);
    if (RESERVED_USERNAMES.has(candidate)) continue;
    if (!(await exists(candidate))) return candidate;
  }
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

function isUsernameConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e.constraint === 'users_username_key';
}

/**
 * Run a user INSERT with a freshly generated username. The existence
 * check and the INSERT are not atomic, so a concurrent insert can take
 * the same name first; on a unique violation of users_username_key the
 * username is regenerated and the INSERT retried.
 */
export async function insertWithGeneratedUsername<T>(
  db: Queryable,
  email: string,
  insert: (username: string) => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const username = await generateUsername(email, async (candidate) => {
      const res = await db.query('SELECT 1 FROM users WHERE username = $1', [candidate]);
      return res.rows.length > 0;
    });
    try {
      return await insert(username);
    } catch (err) {
      if (!isUsernameConflict(err) || attempt >= maxAttempts) throw err;
    }
  }
}
