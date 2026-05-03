import { escapeLikePattern } from './like.js';

/**
 * Append an ILIKE substring search clause to a parameterised WHERE
 * predicate. Used by every list endpoint that exposes `?q=` so the
 * pattern stays consistent: same wildcard escaping, same `%...%`
 * padding, same single-bind reuse across N searched columns.
 *
 * Mutates `params` (push) and returns the new WHERE string. Callers
 * then bind `[...params, limit, offset]` for the SELECT and `params`
 * (without limit/offset) for the COUNT.
 *
 * Whitespace-only or empty `q` short-circuits — no extra bind, no
 * extra clause, so the index-only path stays cheap on no-op searches.
 *
 * @example
 *   let where = 'user_id = $1';
 *   const params: unknown[] = [userId];
 *   where = appendSearchCondition(where, params, q, ['id', 'name']);
 *   // → 'user_id = $1 AND (id ILIKE $2 OR name ILIKE $2)'
 *   // → params: [userId, '%foo%']
 */
export function appendSearchCondition(
  where: string,
  params: unknown[],
  q: string,
  columns: readonly string[]
): string {
  const trimmed = q.trim();
  if (!trimmed) return where;
  const idx = params.length + 1;
  params.push(`%${escapeLikePattern(trimmed)}%`);
  const clause = columns.map((c) => `${c} ILIKE $${idx}`).join(' OR ');
  return `${where} AND (${clause})`;
}
