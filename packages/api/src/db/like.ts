/**
 * Escape LIKE/ILIKE wildcards in user-supplied search input so a query
 * for "100%" matches the literal string "100%" rather than "anything".
 *
 * The three characters PG treats as LIKE metacharacters are %, _, and \\.
 * Backslash is also the default escape character, so escaping it has to
 * come first or we'd wrap our own escape sequences in another pair of
 * escapes. Pair this with the standard `'%' || $N || '%'` substring
 * pattern at the call site for case-insensitive substring search.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}
