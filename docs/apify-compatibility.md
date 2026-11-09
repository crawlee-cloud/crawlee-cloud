# Apify API Compatibility

Crawlee Cloud aims to mirror Apify's wire format for the endpoints that
external clients (notably `apify-client` SDK consumers) call directly.
This doc tracks every known divergence with one of three statuses:

- **DONE** — gap closed; clients see the same shape Apify provides.
- **TODO** — gap known and accepted; will be closed in a future release.
- **WONTFIX** — Crawlee Cloud explicitly diverges; document why.

## Actor addressing

| Gap                                         | Status        | Notes                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v2/actors/...` path segment               | DONE (v1.7.0) | `apify-client` 2.23.4 and later call `/v2/actors/...`; every actor, version and build route is served under both `/v2/acts` and `/v2/actors` by the same handlers (#109).                                                                                                                       |
| `username~name` / `username/name` actor IDs | DONE (v1.7.0) | Every `:actorId` route accepts the ID, the name, `username~name`, or `username/name` (`%2F`) through `packages/api/src/lib/resolve-actor.ts` (#114); usernames and names match case-insensitively, as on Apify. A username other than the caller's is a 404: there is no cross-user lookup.     |
| `username` on actor objects                 | DONE (v1.7.0) | Actor get/create/update responses and list items carry the owner's `username`; list items also carry `stats.lastRunStartedAt` (currently the newest run's creation time rather than its start time; see #142). `GET /v2/acts?my=1` is accepted and ignored (lists are always the caller's own). |
| `username` on `GET /v2/users/me`            | DONE (v1.7.0) | **Behaviour change (#110):** `username` is now a slug (`[a-z0-9-]`, at most 30 characters, derived from the email's local part, unique) and the email moved to a new `email` field. Before, `username` held the email, which broke actor IDs and MCP tool names. Not editable yet.              |
| Public actors / Apify Store                 | WONTFIX       | Actors are user-scoped. `GET /v2/store` searches the caller's own actors only (see below).                                                                                                                                                                                                      |

## Run dispatch (`POST /v2/acts/:actorId/runs`)

| Gap                                                                       | Status            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body is the actor input (Apify contract)                                  | DONE (v1.7.0)     | **Behaviour change (#115).** Before, the input was read from `body.input`, so `actor.start(input)` / `call(input)` from `apify-client` ran with `{}`. One documented ambiguity remains with the legacy wrapper body; see [Run-start contract](#run-start-contract).                                                                                                                                                                                                                                                                                                                                                                     |
| Run options in the query string                                           | DONE (v1.7.0)     | `timeout`, `memory`, `waitForFinish`, `webhooks` (base64 JSON array) and `envVars` (base64 JSON object of strings, a Crawlee Cloud extension). Invalid values return 400 `validation_error`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `webhooks` (per-run webhooks)                                             | DONE              | Per-run webhooks via `webhooks.run_id` column. See `packages/api/src/db/migrate.ts` (run_id ALTER) and `packages/runner/src/queue.ts triggerWebhooks` (match-query union with `run_id IS NULL OR run_id = $3`). Sent as base64 JSON in `?webhooks=`, or in the legacy body.                                                                                                                                                                                                                                                                                                                                                             |
| `headersTemplate` field on per-run webhooks                               | DONE              | JSON-string parsed at INSERT, stored in `webhooks.headers JSONB`. Stringified before INSERT to match the existing admin webhook code path (`routes/webhooks.ts` POST handler).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `build` option for build pinning                                          | TODO              | Accepted and ignored; runs always use the actor's current image. Pin support requires an `actor_versions.build_tag` lookup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `maxItems`, `maxTotalChargeUsd`, `restartOnError`, `forcePermissionLevel` | WONTFIX (ignored) | Accepted and ignored: no pay-per-result billing, and retries come from the actor's `maxRetries`. Values are still validated: `restartOnError` must be `true`/`false`/`1`/`0` and `maxItems`/`maxTotalChargeUsd` non-negative numbers, else 400 `validation_error`.                                                                                                                                                                                                                                                                                                                                                                      |
| `metadata` / `userData` field                                             | WONTFIX           | Use `envVars` (per-run, container env) or per-run `webhooks` instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /v2/acts/:actorId/run-sync` returns the OUTPUT record               | TODO              | Forwards to the run-start route with the query string (run options, `waitForFinish`, `?token=`) and `Authorization` header, and relays its status and JSON response: the **run object**, not the run's `OUTPUT` as on Apify. A parsed body is re-serialized and sent as `application/json` (an empty form-urlencoded body becomes input `{}`); a non-empty form-urlencoded, `text/plain` or `application/octet-stream` body gets the start route's 415 with a JSON hint. Without `?waitForFinish=N` it returns as soon as the run is created; with it, it waits like the run-start route (see [Waiting](#waiting-for-runs-and-builds)). |
| `GET /v2/acts/:actorId/runs`                                              | DONE (v1.7.0)     | Per-actor run list with the query params and response shape of `GET /v2/actor-runs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Run-start contract

As on Apify, the request body **is** the actor input: no body → `{}`, and
non-object JSON (an array, a string) is stored as given. Options come from the
query string, so input keys named `timeout`, `memory`, `envVars` or `webhooks`
are plain input, unless the whole body matches the legacy wrapper (see
[Known ambiguity](#run-start-contract) below, e.g. `{ "timeout": 60 }`).
`text/plain` and `application/octet-stream` bodies return
`415 unsupported-media-type`; an empty `application/x-www-form-urlencoded` body
(what `apify-client` sends for `start()` without input) starts a run with `{}`,
and a non-empty one is a 415 whose message asks for
`Content-Type: application/json`.

**Legacy wrapper body (kept as an extension).** The wrapper body
`{ input, timeout, memory, envVars, webhooks }` sent by `crc call` and the
dashboard before this release keeps working permanently, as a documented
Crawlee Cloud extension: it is detected explicitly and its options are read
from the body. A query option (`?timeout=`, `?memory=`, `?envVars=`,
`?webhooks=`) applies when the wrapper lacks that field, and the wrapper wins on
conflict; `waitForFinish` always comes from the query. A wrapper with an `input`
key and a mistyped option (e.g. `{ "input": {}, "timeout": "60" }`) is a 400
`validation_error`. Each such request is logged as `run-body: legacy` (info
level). New clients should send the Apify shape; current `crc call` and the
dashboard do against an API reporting 1.7.0 or later.

**Known ambiguity.** A body is read as the legacy wrapper when all of
its keys are among `input`, `timeout`, `memory`, `envVars`, `webhooks` and it
either has an `input` key or all its keys have option types. So an actor input
that is exactly `{ "input": ... }` (optionally with option-named keys), or only
option-named keys with option types such as `{ "timeout": 60 }`, is treated as
the wrapper: the run gets `body.input` (or `{}`) as input and those keys as run
options. Workaround: wrap the input (`{ "input": <input> }`), add any other
key to it, or rename the field.

## Waiting for runs and builds

| Gap                                         | Status        | Notes                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v2/actor-runs/:runId?waitForFinish=N` | DONE (v1.7.0) | **Behaviour change (#111):** was ignored, so `apify-client`'s `waitForFinish()` / `call()` polled in a tight loop. Now long-polls until the run is terminal or `N` seconds pass, then returns the current run. `N` is clamped to **60** (Apify also caps it at 60 s), but a request is held for at most **55 s** of wall-clock time. |
| `waitForFinish` on run start                | DONE (v1.7.0) | Same semantics on `POST /v2/acts/:actorId/runs` (#115): the response is held until the run is terminal or the time passes, then the full run object is returned. Without `waitForFinish`, the response is the short run object (`id`, `actId`, `status`, `startedAt`, the default storage IDs, `buildId`, `buildNumber`).            |
| `waitForFinish` on builds                   | DONE (v1.7.0) | Same semantics on `GET /v2/actor-builds/:buildId` (#117). `builds/default` validates it but answers at once: the default build is always finished.                                                                                                                                                                                   |

Details: absent or `0` returns immediately; fractional values are floored; a
negative or non-numeric value is a 400 `validation_error`; an unknown run is an
immediate 404. Whatever `N`, the API answers within 55 s (the current state if
the run is still going), so it beats the 60 s idle timeout of nginx and most load
balancers. The run is re-read
about once per second and a waiting request holds no database connection. A wait
ends early, with the current state, when the client disconnects or the API
starts shutting down. `apify-client` repeats the request until its own wait
budget runs out, so longer waits work through several requests.

**Proxy and platform timeouts.** A long-polled request stays open for up to
55 s with no bytes sent, so every hop in front of the API must allow at least
that:

- **API process**: Fastify's `requestTimeout` and `connectionTimeout` are left at
  0 (no limit).
- **VPS / Caddy** (`deploy/vps/Caddyfile`): `reverse_proxy` sets no response or
  read timeout by default; nothing to change.
- **DigitalOcean App Platform** (`deploy/digitalocean/app.yaml`): requests to web
  components are cut after **100 s** (the edge returns a 504). DigitalOcean's
  [App Platform troubleshooting doc](https://docs.digitalocean.com/support/my-php-app-is-timing-out-and-throwing-5xx-errors/)
  gives 100 s as the maximum request time, and DigitalOcean staff confirm it is a
  fixed limit for all web components in the community
  ([1](https://www.digitalocean.com/community/questions/how-to-resolve-the-100s-request-timeout-of-digital-ocean-s-app-is-there-a-way-to-increase-the-timeout-or-something-else),
  [2](https://www.digitalocean.com/community/questions/app-platform-timeout-limit)).
  55 s fits.
- **Render** (`deploy/render/render.yaml`): "Render allows responses to take up
  to 100 minutes for HTTP requests"
  ([Render vs Heroku](https://render.com/docs/render-vs-heroku-comparison)).
  55 s fits.
- **Your own proxy**: nginx's `proxy_read_timeout` defaults to exactly 60 s, and
  Cloudflare's proxy cuts at 100 s. The 55 s cap stays under a 60 s default
  idle/read timeout, but with only a 5 s margin; raise nginx (or any such proxy)
  to 75 s or more if you see 504s on long-polls.

These figures come from the providers' documentation; they were not measured
against a live deployment.

## Store search

| Gap                                         | Status        | Notes                                                                                                                                  |
| ------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/store`                             | DONE (v1.7.0) | Searches **the caller's own actors** (#119); there is no public store. Backs `client.store().list()` and the MCP `search-actors` tool. |
| Categories, ratings, pricing, public actors | WONTFIX       | Accepted and ignored: `category`, `pricingModel`, `allowsAgenticUsers`, `sortBy`, `includeUnrunnableActors`.                           |

- `search` is split on whitespace into keywords, and every keyword must match
  at least one of `name`, `title`, `description`, the owner's `username` or the
  `username/name` handle (an extension), case-insensitively, as a literal
  substring (`%`, `_` and `\` are not wildcards).
- `limit` defaults to 10 and is clamped to 1–100, or to 1–10 when
  `includeInputSchema=1` (as on Apify); `offset` defaults to 0. A negative or
  non-numeric `limit`/`offset` is a 400, and an `offset` above 1,000,000 is
  clamped to 1,000,000. A repeated string param uses its first value.
- `username` (matched case-insensitively) other than the caller's own returns
  an empty list.
- Ordering: exact (case-insensitive) name or `username/name` match first, then
  most recently modified.
- Response: `{ data: { total, count, offset, limit, desc: false, items } }`. Each
  item has `id`, `name`, `username`, `title` (falls back to `name`),
  `description`, `stats: { totalRuns, lastRunStartedAt }`,
  `currentPricingInfo: { pricingModel: "FREE" }`, `url: null`,
  `pictureUrl: null`, `userPictureUrl: null`, `categories: []`, and, only with
  `includeInputSchema=1`, `inputSchema` (the default build's input schema, or
  `null` when there is none or it has no `properties` object).

## Builds

| Gap                                                                       | Status        | Notes                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/acts/:actorId/builds/default`                                    | DONE (v1.7.0) | `actor.defaultBuild()` (#117). Returns the newest `SUCCEEDED` build of the version tagged `latest`, else the actor's newest `SUCCEEDED` build; never a `RUNNING` build; 404 `record-not-found` if the actor has no successful build. Also under `/v2/actors`. |
| `GET /v2/actor-builds/:buildId`                                           | DONE (v1.7.0) | `client.build(id).get()` (#117). Scoped to the caller through the build's actor.                                                                                                                                                                              |
| `build.actorDefinition` (input schema, README)                            | DONE (v1.7.0) | Stored per build (#112) from `actorDefinition` on actor create/update, which `crc push` sends from `.actor/` (#116). Returned on the two routes above only (`null` for builds pushed before this release; push again to fill it).                             |
| Build fields `actId`, `userId`, `buildNumber`, `meta`, `stats`, `options` | DONE (v1.7.0) | Additive on every build response. `buildNumber` is `<version>.<n>` (the build ID for a build with no version); `meta`, `stats` and `options` are empty objects.                                                                                               |
| `GET /v2/actor-builds/:buildId/log`, `POST .../builds` that finishes      | TODO          | Builds are created by `crc push`; `POST /v2/acts/:actorId/builds` records a `RUNNING` build that nothing finishes. The MCP `builds` tool category is unsupported.                                                                                             |

## Webhook delivery

| Gap                                                  | Status        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource.usageTotalUsd` field                       | DONE (v1.7.0) | Always `0` — Crawlee Cloud has no usage tracking yet. Mirrored across `packages/runner/src/queue.ts defaultPayload.resource` and `packages/api/src/routes/webhooks.ts buildWebhookPayload` (KEEP IN SYNC pair).                                                                                                                                                                                                                                                                                                                               |
| `ACTOR.RUN.TIMED_OUT` event type                     | DONE (v1.7.0) | Apify uses HYPHEN for run.status (`'TIMED-OUT'`) but UNDERSCORE for event type (`'ACTOR.RUN.TIMED_OUT'`). Crawlee Cloud now matches both: status stays hyphen-form (Apify-canonical), event-type construction translates via `status.replace(/-/g, '_')` in `packages/runner/src/queue.ts` (`triggerWebhooks`).                                                                                                                                                                                                                               |
| Apify-compatible payload-template engine             | DONE (v0.9.1) | Dot-notation, quoted/unquoted forms, mid-string interpolation, fallback-on-error. See `packages/api/src/webhooks/apply-template.ts` and the mirrored `packages/runner/src/webhook-template.ts`.                                                                                                                                                                                                                                                                                                                                               |
| Per-run webhooks (`webhooks` field on run create)    | DONE (v1.7.0) | See above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Runtime templating of `headersTemplate` (`{{vars}}`) | TODO          | Currently only `payloadTemplate` runs through engine. Per-run headers are JSON.parsed at INSERT-time and delivered statically. Non-blocking for known clients; full templating engine application is the right long-term parity.                                                                                                                                                                                                                                                                                                              |
| `ACTOR.RUN.CREATED` + `ACTOR.RUN.RESURRECTED` events | TODO          | Crawlee Cloud only fires the four terminal events (SUCCEEDED, FAILED, TIMED_OUT, ABORTED). The Zod enum in `packages/api/src/schemas/webhooks.ts` (`SUPPORTED_WEBHOOK_EVENTS`) rejects subscriptions to the two missing events with a 400 — louder than accepting rows that silently never deliver. Closing the gap = fire CREATED at run-insert (best-effort, off the critical path) in `packages/api/src/routes/actors.ts`, and fire RESURRECTED in `packages/api/src/routes/runs.ts` (the `POST /v2/actor-runs/:runId/resurrect` handler). |
| HMAC webhook signature header                        | TODO          | Security hardening for follow-up. Bearer auth on the receiver side is sufficient short-term.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Auth

| Gap                                           | Status      | Notes                                                                                                 |
| --------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| Token-in-query (`?token=` for read endpoints) | DONE (v0.7) | `packages/api/src/auth/middleware.ts` (`authenticate`) accepts `?token=` for any authenticated route. |
| API keys with `cp_` prefix                    | DONE        | `packages/api/src/auth/index.ts` (`API_KEY_PREFIX`).                                                  |
| JWT tokens with 7-day TTL                     | DONE        | `packages/api/src/auth/index.ts` (`JWT_EXPIRES_IN`).                                                  |

## Dataset / KV / runs read APIs

| Gap                                                       | Status          | Notes                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/datasets/:id/items` shape                        | DONE            | Returns array; paginates via `x-apify-pagination-*` response headers.                                                                                                                                                                                                                                                                                                                              |
| `?clean=true&format=json` query params                    | DONE (no-op)    | Crawlee Cloud's items endpoint already returns clean JSON; flags accepted but ignored by Fastify (loose querystring handling).                                                                                                                                                                                                                                                                     |
| `fields` / `omit` / `desc` on dataset items               | DONE (v1.7.0)   | On `GET /v2/datasets/:id/items` and `GET /v2/actor-runs/:runId/dataset/items` (#113). `fields=a,b` keeps only those top-level keys in that order; `omit=a,b` then drops keys; `desc=1` returns newest first with `offset` counted from the end. Empty `fields=` / `omit=` (sent by `apify-client` for unset options) mean "absent". Applies to paged, no-`limit` streaming and `download=1` reads. |
| `flatten` on dataset items                                | TODO            | Accepted and ignored.                                                                                                                                                                                                                                                                                                                                                                              |
| Boolean query params as `1` / `0`                         | DONE (v1.7.0)   | `apify-client` sends booleans as `1`/`0`. `desc` (run list and dataset items), `download` (dataset items), `forefront` (request queues), `tail` (run logs), `includeInputSchema` (`GET /v2/store`) and `restartOnError` (run start) accept `true`/`false`/`1`/`0`. **Behaviour change:** any other value (e.g. `forefront=yes`) is now 400 `validation_error` instead of `false`.                  |
| Run list `status` list and `startedAfter`/`startedBefore` | DONE (v1.7.0)   | `status=SUCCEEDED,FAILED` matches any listed status (how `apify-client` sends an array); `startedAfter`/`startedBefore` filter on the run's start time with inclusive bounds, as on Apify (`since`/`until` stay on creation time).                                                                                                                                                                 |
| `POST /v2/actor-runs/:id/rerun`                           | N/A (extension) | Not an Apify endpoint — Crawlee Cloud extension (since 1.7.0). Clones a terminal run into a NEW run (fresh id/storages, copied INPUT + per-run webhooks + envVars, `originRunId` lineage). Exists because resurrect reuses the run id, which webhook consumers with per-run-id idempotency treat as a duplicate and drop. `apify-client` won't call it; the dashboard and custom tooling do.       |

## Abort and errors

| Gap                                     | Status        | Notes                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abort of a finished run returns the run | DONE (v1.7.0) | **Behaviour change (#113):** `POST /v2/actor-runs/:id/abort` on a run that already finished returns **200 with the unchanged run** instead of 404 (`apify-client`'s `abort()` threw). Unknown runs and other users' runs are still 404.                                                                                                                                                   |
| Abort of a `READY` run                  | DONE (v1.7.0) | A queued run moves straight to `ABORTED` (no runner ever claims it), and matching `ACTOR.RUN.ABORTED` webhooks are delivered.                                                                                                                                                                                                                                                             |
| Error envelope for unknown routes       | DONE (v1.7.0) | **Behaviour change (#109):** a route that does not exist returns `404 { "error": { "type": "page-not-found", "message": "Route <METHOD> <path> not found" } }` instead of Fastify's `{ message, error, statusCode }`. It is deliberately not `record-not-found`, which `apify-client` turns into `undefined`; 404s for missing resources on existing routes still use `record-not-found`. |

## Client SDK compat

| Gap                                           | Status        | Notes                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apify-client` SDK pointed via `baseUrl`      | PARTIAL       | Integration tests cover `apify-client` 2.25 for actor get/list/update, `username/name` lookup, `start`/`call` input, `waitForFinish`, default builds and `store().list()`. Methods for tasks, schedules and public-store features are not covered. |
| Apify MCP server (`@apify/actors-mcp-server`) | DONE (v1.7.0) | Version 0.17.3 works unmodified with `APIFY_API_BASE_URL`; all 19 checks of the harness in `tests/mcp-e2e/` pass with no expected failures. Supported tool set and limits: [MCP (AI agents)](./mcp.md).                                            |

## How to add a row

When integrating a new client and discovering a new gap:

1. Add a row to the relevant section above with status TODO.
2. If you fix it in the same PR, set status to DONE and reference the changing files.
3. If the divergence is intentional, set status to WONTFIX and document the reason.

This doc is the canonical bookkeeping for cross-platform compat — keep
it in sync with implementation as gaps are closed.
