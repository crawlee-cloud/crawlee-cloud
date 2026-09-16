# MCP Server Implementation Plan

Plan for adding Model Context Protocol (MCP) features to Crawlee Cloud with full
feature parity with Apify's MCP offering (as of `@apify/actors-mcp-server` v0.15.x,
September 2026). Tracks the "Platform MCP server" roadmap item (RFC discussion #96).

## What Apify ships today (parity target)

Apify's MCP surface has three layers:

1. **Hosted platform MCP server** (`https://mcp.apify.com`) — Streamable HTTP
   transport (legacy SSE removed, gone platform-wide April 2026), OAuth or
   `Authorization: Bearer <token>` auth, tool selection via `?tools=` query
   parameter. Tool categories:
   - `actors` (default): `search-actors`, `fetch-actor-details`, `call-actor`
   - `docs` (default): `search-apify-docs`, `fetch-apify-docs`
   - `runs`: `get-actor-run`, `get-actor-run-list`, `get-actor-run-log`, `abort-actor-run`
   - `storage`: `get-dataset`, `get-dataset-items`, `get-dataset-schema`,
     `get-dataset-list`, `get-key-value-store`, `get-key-value-store-record`,
     `get-key-value-store-keys`, `get-key-value-store-list`
   - `tasks`: create/get/update actor tasks
   - `schedules`: create/get/update/delete schedules
   - Named actors loadable as individual tools (`?tools=apify/rag-web-browser`),
     with input-schema-derived tool schemas and inferred **output schemas**.
   - Auto-injection: when `call-actor` or an actor tool is present, `get-actor-run`,
     `get-dataset-items`, `get-key-value-store-record`, `abort-actor-run` load too.
   - Tool annotations (`readOnlyHint`, `openWorldHint`, titles) on every tool.
2. **stdio server** (`npx @apify/actors-mcp-server`) — same tools, local process,
   token from env, `--tools` flag mirrors `?tools=`.
3. **Actorized MCP servers** — any actor running in **Standby mode** (long-lived
   HTTP server container, platform routes requests to it) can expose `/mcp` and
   act as its own MCP server.

Out of scope for parity (tied to Apify's commercial infrastructure, not platform
mechanics): x402/Skyfire/AGI payments, telemetry + Sentry, MCP Apps `ui=true`
widget rendering, Apify Store rental actors.

## Current state of this repo

- No MCP code exists (`ROADMAP.md:32` only). No `@modelcontextprotocol/sdk` dep.
- Fastify 5 API with per-resource route plugins registered at `/v2`
  (`packages/api/src/index.ts:137-148`); auth via `authenticate` preHandler
  (`packages/api/src/auth/middleware.ts:26`), Bearer `cp_` API keys with
  `?token=` query fallback.
- Every tool we need maps to an existing handler: list/get actors
  (`routes/actors.ts:172/:315`), start run (`actors.ts:560`), get/abort run
  (`routes/runs.ts:277/:587`), run logs (`routes/logs.ts:65`), dataset items
  (`routes/datasets.ts:178`, `runs.ts:1076`), KV keys/records
  (`routes/key-value-stores.ts:171/:207`), schedules (`routes/schedules.ts`).
- Gaps vs. Apify:
  - Run-start logic is inlined in `actors.ts:590-710` and duplicated in
    `runs.ts` rerun — no shared service to call from MCP tools.
  - `run-sync` (`actors.ts:732`) does not actually wait; no
    `run-sync-get-dataset-items`.
  - `actors` / `actor_versions` tables have **no input schema and no README**
    columns — nothing to derive per-actor tool schemas from.
  - No actor tasks feature at all (no table, routes, or CLI support).
  - Standby mode is dead scaffolding: `docker.ts:818-819` sets
    `APIFY_CONTAINER_PORT`/`APIFY_CONTAINER_URL` but nothing names the
    container, exposes a port, routes traffic, or writes `runs.container_url`.

## Phase 1 — Platform MCP server over Streamable HTTP

**Goal:** `https://<host>/mcp` speaks MCP to Claude/Cursor/etc. with the core
tool catalog, authenticated by existing API keys.

- Add `@modelcontextprotocol/sdk` (^1.x) to `packages/api`.
- New `packages/api/src/mcp/` module:
  - `server.ts` — builds an `McpServer` per request scope; **stateless
    Streamable HTTP** (JSON response mode, no `Mcp-Session-Id` persistence) to
    stay horizontally scalable; no legacy SSE endpoint (Apify removed it).
  - `tools/actors.ts`, `tools/runs.ts`, `tools/storage.ts`, `tools/schedules.ts`,
    `tools/docs.ts` — one file per category; each tool calls the same DB/S3/Redis
    helpers the REST handlers use (not `fastify.inject`, so errors and types stay
    structured). Tool names, input shapes, annotations (`readOnlyHint` etc.) and
    result JSON copy Apify's exactly.
  - `tool-selection.ts` — parses `?tools=` (categories, `user/actor-name`
    selectors, comma-separated; `?actors=` back-compat alias), default set =
    `actors,docs`, plus Apify's auto-injection rule.
- New route `packages/api/src/routes/mcp.ts` (`FastifyPluginAsync`):
  - `POST /mcp` → transport.handleRequest; `GET /mcp` → 405 (stateless mode);
    mounted **unprefixed** (like health/metrics) at `index.ts:~150`, since
    Apify's server lives at the host root, not under the REST API version.
  - `preHandler: authenticate` — Bearer token and `?token=` both already work
    (`middleware.ts:36`). Unauthenticated requests get discovery-only tools
    (`search-actors`, docs) mirroring Apify's limited anonymous mode.
- **Refactor prerequisite:** extract `actors.ts:590-710` into
  `packages/api/src/services/start-run.ts#startRun()` (storage-record creation,
  INPUT KV write, build lookup, `runs` INSERT, envVars Redis stash, webhook rows,
  `redis.publish('run:new', runId)`), and reuse it from the REST route, rerun,
  the scheduler, and the MCP `call-actor` tool. Removes the existing
  KEEP-IN-SYNC duplication as a side benefit.
- `docs` category: `search-crawlee-cloud-docs` / `fetch-crawlee-cloud-docs`
  serving the markdown under `docs/` (build a small lunr/minisearch index at
  startup). Keep Apify's tool *shapes* so clients behave identically.
- Tests in `packages/api/test/mcp.test.ts` using the SDK's
  `StreamableHTTPClientTransport` against `app.inject`-style listeners, with the
  existing `vi.mock` auth pattern.

**Deliverable:** initialize/list-tools/call-tool round trip; `call-actor`
starts a real run; storage/runs/schedules tools return Apify-shaped payloads.

## Phase 2 — Actor input schemas, READMEs, and per-actor tools

**Goal:** `fetch-actor-details` returns schema + README; named actors become
dynamic tools with real input schemas and inferred output schemas.

- Migration (`db/migrate.ts`): `actor_versions.input_schema JSONB`,
  `actor_versions.readme TEXT` (versioned, like Apify), mirrored convenience
  columns or a view on `actors` for the current version.
- CLI `push` (`packages/cli/src/commands/push.ts`): read
  `.actor/input_schema.json` (or `actor.json#input`) and `README.md` from the
  actor dir, include in the version payload; registry routes
  (`routes/registry.ts`) accept and store them.
- REST: expose on `GET /v2/acts/:actorId` and version endpoints (Apify field
  names: `inputSchema`, `readme`).
- MCP:
  - `fetch-actor-details` returns title, description, README, input schema,
    default run options.
  - `?tools=<user>/<actor-name>` loads that actor as a standalone tool: JSON
    Schema translated to MCP tool input schema with Apify's normalizations
    (descriptions truncated at 500 chars, enums > 2000 chars replaced with
    examples, `prefill`/`default` handling).
  - **Output schema inference**: sample the first dataset items of the latest
    successful run to synthesize a field-level output schema, cached per
    actor+build (Apify's newest feature; best-effort, omitted when no runs).
  - `add-actor` tool + `notifications/tools/list_changed` for dynamic sessions
    (only meaningful once sessions are stateful — see Phase 6 note; until then
    `call-actor` covers the same ground statelessly, which is also Apify's
    recommended path).

## Phase 3 — Synchronous execution

**Goal:** real `run-sync` semantics so `call-actor` can return results, not
just a run ID.

- Runner: publish `run:finished:<runId>` (with terminal status) on completion in
  `packages/runner/src/queue.ts` where status is finalized.
- API: `packages/api/src/services/wait-for-run.ts` — Redis subscribe with DB
  poll fallback and deadline (cap ~300s like Apify, then return the running
  run object with 408-equivalent semantics).
- Fix `POST /v2/acts/:actorId/run-sync` (`actors.ts:732`) to actually wait; add
  `POST /v2/acts/:actorId/run-sync-get-dataset-items`.
- MCP `call-actor` and per-actor tools: wait by default, return
  `{ runId, status, datasetId, items: [...first N...] }` plus the auto-injected
  follow-up tools for pagination — matching Apify's tool output contract.

## Phase 4 — stdio server + CLI integration

**Goal:** local `npx`-style usage identical to `@apify/actors-mcp-server`.

- New package `packages/mcp-server` (`@crawlee-cloud/mcp-server`, bin
  `crawlee-cloud-mcp`): thin stdio transport that serves the same tool catalog
  by calling the platform REST API (`CRAWLEE_CLOUD_API_BASE_URL` +
  `CRAWLEE_CLOUD_TOKEN`, with `APIFY_TOKEN` accepted as alias). Flags: `--tools`,
  same selector grammar.
- Reuse Phase 1 tool definitions: move tool schemas/handlers into a shared
  internal module consumed by both the API route (direct DB/S3 access) and the
  stdio package (REST client access) — an interface with two backends.
- CLI: `crc mcp` command (`packages/cli/src/commands/mcp.ts` + one
  `addCommand` in `src/index.ts`) that launches the stdio server using the
  current profile's stored token/base URL.

## Phase 5 — Standby mode → Actorized MCP servers

**Goal:** any actor can be a long-running HTTP server; ones exposing `/mcp`
become MCP servers, reachable through the platform. Biggest lift.

- Schema: `actors.standby JSONB` (enabled, desiredRequests, idleTimeoutSecs,
  build), `runs.origin` (`STANDBY` vs `API`/`SCHEDULE`), reuse existing
  `runs.container_url`.
- Runner (`docker.ts`):
  - Name containers `run-<runId>`, set `ExposedPorts`/`PortBindings` (or rely on
    shared `config.dockerNetwork` DNS), making the existing
    `APIFY_CONTAINER_URL=http://run-<runId>:4321` env var true instead of dead.
  - Standby launches: set `APIFY_STANDBY_MODE=1`, wait for readiness probe on
    the container port, then write `runs.container_url`; no timeout kill, idle
    timeout instead (terminate after N seconds without proxied requests).
- API: reverse-proxy route `ALL /v2/acts/:actorId/standby/*` (via
  `@fastify/http-proxy`) → resolve/start a standby run (cold start on first
  request, like Apify), forward with streaming; count in-flight requests for
  idle tracking; auth happens at the proxy, container trusts the network.
- MCP tie-in: an actor with standby enabled and an MCP path configured is
  listed by `fetch-actor-details` with its MCP URL
  (`https://<host>/v2/acts/<id>/standby/mcp`), and `call-actor` can proxy a
  single MCP tool call into it. This is Apify's "MCPify any actor" story.

## Phase 6 — Remaining parity + hardening

- **Actor tasks** (prereq for the `tasks` MCP category): `tasks` table
  (actor_id, name, input JSONB, options), REST CRUD at `/v2/actor-tasks`
  (Apify shapes), `POST /v2/actor-tasks/:id/runs`, then MCP
  `create/get/update-actor-task` tools. Schedules already exist — only tools
  needed.
- **OAuth 2.1** (MCP spec authorization) so claude.ai/web clients can connect
  without pasting keys: authorization-code + PKCE endpoints issuing short-lived
  tokens bound to an API key; `.well-known/oauth-protected-resource` metadata.
  Bearer keys remain the primary path; OAuth is additive.
- **Stateful sessions** (`Mcp-Session-Id`, Redis-backed) to enable `add-actor`
  dynamic tool loading with `tools/list_changed`; optional, feature-flagged.
- Prometheus counters for MCP tool calls (existing `metrics.ts` pattern),
  rate limiting reusing API-key limits, `?ui=`/`?telemetry-enabled=` params
  accepted-and-ignored for client config compatibility.
- Docs page `docs/mcp.md` + dashboard "Connect an AI agent" snippet.

## Sequencing and effort

| Phase | Depends on | Size |
|---|---|---|
| 1. Streamable HTTP server + core tools | — | ~1 week |
| 2. Input schemas / READMEs / actor tools | 1 | ~1 week |
| 3. Sync runs | 1 | 2–3 days |
| 4. stdio + CLI | 1 (2 nice-to-have) | 2–3 days |
| 5. Standby + Actorized MCP | 1 | 2–3 weeks |
| 6. Tasks, OAuth, sessions, polish | 1–3 | 1–2 weeks |

Phases 1+3 alone already make the platform usable from Claude/Cursor
("run this actor, get me the data"); 2 and 4 reach day-to-day Apify parity;
5 is the differentiating platform feature and can proceed in parallel after
Phase 1 lands.
