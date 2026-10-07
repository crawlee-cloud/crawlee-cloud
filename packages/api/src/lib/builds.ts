/**
 * Shared build queries and the build response shape.
 *
 * Used by the registry routes (`/acts/:actorId/builds/...`,
 * `/actor-builds/:buildId`) and reusable by anything that needs an actor's
 * default build — e.g. the store listing's `includeInputSchema` (#119), which
 * uses the batch `selectDefaultInputSchemas` rather than one query per actor.
 *
 * None of the helpers here check ownership except `loadBuild`: callers that
 * pass an actor ID must have authorized access to that actor already.
 */

import type { ActorDefinition } from '../schemas/actors.js';
import { query } from '../db/index.js';
import type { Queryable } from './resolve-actor.js';

export interface BuildRow {
  id: string;
  actor_id: string;
  version_id: string | null;
  status: string;
  started_at: Date | null;
  finished_at: Date | null;
  image_name: string | null;
  image_digest: string | null;
  image_size_bytes: number | null;
  log_count: number;
  git_branch: string | null;
  git_commit: string | null;
  created_at: Date;
  // Joined from actor_versions when available — exposes the source version
  // ("0.1") and tag ("latest") to the dashboard without requiring a second
  // request per row.
  version_number?: string | null;
  build_tag?: string | null;
  // Joined from actors / computed by BUILD_NUMBER_SQL (#117).
  user_id?: string | null;
  build_number?: string | null;
  // Present only when the query selected it (detail endpoints, #112/#117).
  actor_definition?: ActorDefinition | null;
}

// Explicit build columns. actor_definition (#112) is deliberately left out:
// it can be ~1.5 MB per row and is served only by the build-detail endpoints
// that need it, so lists must never read it via `*`.
export const BUILD_COLUMNS = `id, actor_id, version_id, status, started_at, finished_at, image_name,
  image_digest, image_size_bytes, log_count, git_branch, git_commit, created_at`;
export const BUILD_COLUMNS_B = `b.id, b.actor_id, b.version_id, b.status, b.started_at,
  b.finished_at, b.image_name, b.image_digest, b.image_size_bytes, b.log_count, b.git_branch,
  b.git_commit, b.created_at`;

/**
 * Apify-style `buildNumber` for build `b` (joined with its version `v`):
 * `<version_number>.<n>`, where n is the build's 1-based position among its
 * version's builds by `created_at` (id breaks ties) — a correlated
 * ROW_NUMBER(). Falls back to the build ID when the build has no version.
 *
 * Counts only *earlier* builds, so it also works when `b` is a row being
 * inserted in the same statement (a CTE source the subquery can't see yet).
 * List queries use the cheaper window form, BUILD_NUMBER_WINDOW_SQL.
 */
const BUILD_NUMBER_SQL = `CASE WHEN v.version_number IS NULL THEN b.id
  ELSE v.version_number || '.' || (
    SELECT COUNT(b2.id) + 1 FROM actor_builds b2
     WHERE b2.version_id = b.version_id
       AND (b2.created_at, b2.id) < (b.created_at, b.id))
  END`;

/**
 * Same numbering as BUILD_NUMBER_SQL for a query over all of one actor's
 * builds: every build of a version belongs to that version's actor, so the
 * partition is complete.
 */
export const BUILD_NUMBER_WINDOW_SQL = `CASE WHEN v.version_number IS NULL THEN b.id
  ELSE v.version_number || '.' ||
    ROW_NUMBER() OVER (PARTITION BY b.version_id ORDER BY b.created_at, b.id)
  END`;

/**
 * `SELECT … FROM <source> b` with the joined version, owner and build
 * number. `source` is `actor_builds` or a CTE with BUILD_COLUMNS (e.g. the
 * RETURNING of an insert/update). `definition` adds `b.actor_definition`.
 */
export function buildSelectSql(source = 'actor_builds', opts: { definition?: boolean } = {}) {
  return `SELECT ${BUILD_COLUMNS_B}, v.version_number, v.build_tag, a.user_id,
      ${BUILD_NUMBER_SQL} AS build_number${opts.definition ? ', b.actor_definition' : ''}
    FROM ${source} b
    JOIN actors a ON a.id = b.actor_id
    LEFT JOIN actor_versions v ON v.id = b.version_id`;
}

/**
 * Default-build choice, as a WHERE + ORDER BY tail for a query from
 * `buildSelectSql()` where `actorIdExpr` is the actor:
 *
 *   1. the newest SUCCEEDED build of the version tagged `latest`;
 *   2. else the newest SUCCEEDED build of the actor.
 *
 * Never a RUNNING / READY build: `POST /builds` creates RUNNING rows that
 * nothing ever finishes (build_queue has no consumer), and those must not
 * shadow the pushed build.
 */
function defaultBuildTail(actorIdExpr: string) {
  return `WHERE b.actor_id = ${actorIdExpr} AND b.status = 'SUCCEEDED'
    ORDER BY COALESCE(v.build_tag = 'latest', false) DESC, b.created_at DESC, b.id DESC
    LIMIT 1`;
}

/**
 * The actor's default build (see defaultBuildTail) with its actor
 * definition, or null when it has no SUCCEEDED build. Each call checks out
 * its own pooled connection (safe as a `waitForTerminal` loader).
 */
export async function selectDefaultBuild(
  actorId: string,
  db: Queryable = { query }
): Promise<BuildRow | null> {
  const result = await db.query<BuildRow>(
    `${buildSelectSql('actor_builds', { definition: true })} ${defaultBuildTail('$1')}`,
    [actorId]
  );
  return result.rows[0] ?? null;
}

/**
 * Batch form of selectDefaultBuild: one query (LATERAL join per actor) for
 * many actors. Actors without a SUCCEEDED build are absent from the map.
 * `definition: false` skips the (large) actor_definition column.
 */
export async function selectDefaultBuilds(
  actorIds: readonly string[],
  opts: { definition?: boolean } = {},
  db: Queryable = { query }
): Promise<Map<string, BuildRow>> {
  const builds = new Map<string, BuildRow>();
  if (actorIds.length === 0) return builds;

  const result = await db.query<BuildRow>(
    `SELECT d.* FROM unnest($1::varchar[]) AS ids(actor_id)
     CROSS JOIN LATERAL (
       ${buildSelectSql('actor_builds', { definition: opts.definition ?? true })}
       ${defaultBuildTail('ids.actor_id')}
     ) d`,
    [[...new Set(actorIds)]]
  );
  for (const row of result.rows) builds.set(row.actor_id, row);
  return builds;
}

/**
 * The input schema (`actor_definition.input`) of each actor's default build,
 * in one query. Same choice as selectDefaultBuilds, but reads only the
 * `input` key so a list doesn't ship every README (up to 1 MB each) out of
 * Postgres. Actors without a SUCCEEDED build, or whose default build has no
 * input schema, are absent from the map.
 */
export async function selectDefaultInputSchemas(
  actorIds: readonly string[],
  db: Queryable = { query }
): Promise<Map<string, unknown>> {
  const schemas = new Map<string, unknown>();
  if (actorIds.length === 0) return schemas;

  const result = await db.query<{ actor_id: string; input: unknown }>(
    `SELECT ids.actor_id, d.input FROM unnest($1::varchar[]) AS ids(actor_id)
     CROSS JOIN LATERAL (
       SELECT b.actor_definition -> 'input' AS input
         FROM actor_builds b
         LEFT JOIN actor_versions v ON v.id = b.version_id
       ${defaultBuildTail('ids.actor_id')}
     ) d`,
    [[...new Set(actorIds)]]
  );
  for (const row of result.rows) {
    if (row.input != null) schemas.set(row.actor_id, row.input);
  }
  return schemas;
}

/**
 * One build with its actor definition, scoped to the owner of its actor
 * (`actor_builds.actor_id → actors.user_id`), or null. Safe as a
 * `waitForTerminal` loader.
 */
export async function loadBuild(buildId: string, userId: string): Promise<BuildRow | null> {
  const result = await query<BuildRow>(
    `${buildSelectSql('actor_builds', { definition: true })} WHERE b.id = $1 AND a.user_id = $2`,
    [buildId, userId]
  );
  return result.rows[0] ?? null;
}

/**
 * The build response. The original fields (used by the dashboard) are
 * unchanged; the Apify fields (`actId`, `userId`, `buildNumber`, `meta`,
 * `stats`, `options`) were added for apify-client (#117). `actorDefinition`
 * is present only when the query selected it, so lists don't claim builds
 * have no definition.
 */
export function formatBuild(row: BuildRow) {
  return {
    id: row.id,
    actorId: row.actor_id,
    versionId: row.version_id,
    // versionNumber + buildTag come from a LEFT JOIN on actor_versions.
    // They're null for builds whose version was deleted.
    versionNumber: row.version_number ?? null,
    buildTag: row.build_tag ?? null,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    imageName: row.image_name,
    imageDigest: row.image_digest,
    imageSizeBytes: row.image_size_bytes,
    logCount: row.log_count,
    gitBranch: row.git_branch,
    gitCommit: row.git_commit,
    createdAt: row.created_at,
    actId: row.actor_id,
    userId: row.user_id ?? null,
    buildNumber: row.build_number ?? null,
    meta: {},
    stats: {},
    options: {},
    ...(row.actor_definition !== undefined ? { actorDefinition: row.actor_definition } : {}),
  };
}
