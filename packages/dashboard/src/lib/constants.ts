/**
 * Centralized constants for the dashboard. Keep here anything used in
 * more than one component or that anyone might reasonably want to tune
 * (page sizes, polling cadences, ephemeral UI timeouts).
 *
 * Env-driven runtime config belongs elsewhere — these are compile-time
 * defaults that ship with the build. Cross-package shared values (e.g.
 * Apify-shape types) belong in a future packages/shared workspace.
 */

import packageJson from '../../package.json';

/**
 * Dashboard version string, sourced from package.json so the UI label
 * advances with every release instead of drifting against a hardcoded
 * "v0.1". Read at build time; the bundler inlines the literal.
 */
export const APP_VERSION: string = packageJson.version;

/** Rows per page on every dashboard list view. */
export const PAGE_SIZE = 50;

/**
 * Cap for "fetch everything for a dropdown / summary" calls. Used where
 * we need the full set client-side (actor dropdown for runs/new, webhook
 * actor map, dashboard stats counters). Bounded so the dashboard doesn't
 * try to materialize 100K rows on a runaway account.
 */
export const FETCH_ALL_LIMIT = 1000;

/** How many log lines the run-detail page tails on first load. */
export const LOG_TAIL_LIMIT = 500;

/** How many dataset items the run-detail page previews. */
export const DATASET_PREVIEW_LIMIT = 200;

/** How many KV-store keys the KV-detail page previews. */
export const KV_KEYS_PREVIEW_LIMIT = 100;

/** Refresh cadence for the admin retention status page. */
export const POLL_RETENTION_MS = 30_000;

/** Refresh cadence for the runners page (more aggressive, runner state moves). */
export const POLL_RUNNERS_MS = 5_000;

/** How long the "copied!" feedback stays visible after a clipboard write. */
export const COPY_FEEDBACK_MS = 2_000;
