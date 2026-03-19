/**
 * Route prefix for when the dashboard is deployed behind a path-based
 * reverse proxy (e.g., DO App Platform at /dashboard).
 *
 * The proxy strips the prefix before forwarding, so Next.js sees "/" internally.
 * But browser-facing URLs (links, redirects) need the prefix so the proxy
 * routes them to the dashboard service instead of the API.
 */
export const ROUTE_PREFIX = process.env.NEXT_PUBLIC_ROUTE_PREFIX || '';

/** Prefix a path for browser navigation. No-op when ROUTE_PREFIX is empty. */
export function prefixPath(path: string): string {
  if (!ROUTE_PREFIX) return path;
  if (path.startsWith(ROUTE_PREFIX)) return path;
  return `${ROUTE_PREFIX}${path}`;
}
