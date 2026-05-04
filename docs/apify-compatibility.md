# Apify API Compatibility

Crawlee Cloud aims to mirror Apify's wire format for the endpoints that
external clients (notably `apify-client` SDK consumers) call directly.
This doc tracks every known divergence with one of three statuses:

- **DONE** — gap closed; clients see the same shape Apify provides.
- **TODO** — gap known and accepted; will be closed in a future release.
- **WONTFIX** — Crawlee Cloud explicitly diverges; document why.

## Run dispatch (`POST /v2/acts/:actorId/runs`)

| Gap                                         | Status              | Notes                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhooks` field accepted in body           | DONE (next release) | Per-run webhooks via `webhooks.run_id` column. See `packages/api/src/db/migrate.ts` (run_id ALTER) and `packages/runner/src/queue.ts triggerWebhooks` (match-query union with `run_id IS NULL OR run_id = $3`). |
| `headersTemplate` field on per-run webhooks | DONE (next release) | JSON-string parsed at INSERT, stored in `webhooks.headers JSONB`. Stringified before INSERT to match the existing admin webhook code path (`routes/webhooks.ts` POST handler).                                  |
| `build` field for build pinning             | TODO                | Currently always uses latest SUCCEEDED build. Most clients use `'latest'` so non-blocking; pin support requires `actor_versions.build_tag` lookup.                                                              |
| `metadata` / `userData` field               | WONTFIX             | Use `envVars` (per-run, container env) or per-run `webhooks` instead.                                                                                                                                           |

## Webhook delivery

| Gap                                                  | Status              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource.usageTotalUsd` field                       | DONE (next release) | Always `0` — Crawlee Cloud has no usage tracking yet. Mirrored across `packages/runner/src/queue.ts defaultPayload.resource` and `packages/api/src/routes/webhooks.ts buildWebhookPayload` (KEEP IN SYNC pair).                                                                                                                                                                                                                                                                                                       |
| `ACTOR.RUN.TIMED_OUT` event type                     | DONE (next release) | Apify uses HYPHEN for run.status (`'TIMED-OUT'`) but UNDERSCORE for event type (`'ACTOR.RUN.TIMED_OUT'`). Crawlee Cloud now matches both: status stays hyphen-form (Apify-canonical), event-type construction translates via `status.replace(/-/g, '_')` in `packages/runner/src/queue.ts:382`.                                                                                                                                                                                                                       |
| Apify-compatible payload-template engine             | DONE (v0.9.1)       | Dot-notation, quoted/unquoted forms, mid-string interpolation, fallback-on-error. See `packages/api/src/webhooks/apply-template.ts` and the mirrored `packages/runner/src/webhook-template.ts`.                                                                                                                                                                                                                                                                                                                       |
| Per-run webhooks (`webhooks` field on run create)    | DONE (next release) | See above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Runtime templating of `headersTemplate` (`{{vars}}`) | TODO                | Currently only `payloadTemplate` runs through engine. Per-run headers are JSON.parsed at INSERT-time and delivered statically. Non-blocking for known clients; full templating engine application is the right long-term parity.                                                                                                                                                                                                                                                                                      |
| `ACTOR.RUN.CREATED` + `ACTOR.RUN.RESURRECTED` events | TODO                | Crawlee Cloud only fires the four terminal events (SUCCEEDED, FAILED, TIMED_OUT, ABORTED). The Zod enum in `packages/api/src/schemas/webhooks.ts` (`SUPPORTED_WEBHOOK_EVENTS`) rejects subscriptions to the two missing events with a 400 — louder than accepting rows that silently never deliver. Closing the gap = fire CREATED at run-insert (best-effort, off the critical path) in `packages/api/src/routes/actors.ts`, and fire RESURRECTED in the resurrect handler at `packages/api/src/routes/runs.ts:223`. |
| HMAC webhook signature header                        | TODO                | Security hardening for follow-up. Bearer auth on the receiver side is sufficient short-term.                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Auth

| Gap                                           | Status      | Notes                                                                                   |
| --------------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| Token-in-query (`?token=` for read endpoints) | DONE (v0.7) | `packages/api/src/auth/middleware.ts:35` accepts `?token=` for any authenticated route. |
| API keys with `cp_` prefix                    | DONE        | `packages/api/src/auth/index.ts:17` `API_KEY_PREFIX`.                                   |
| JWT tokens with 7-day TTL                     | DONE        | `packages/api/src/auth/index.ts:16` `JWT_EXPIRES_IN`.                                   |

## Dataset / KV / runs read APIs

| Gap                                    | Status       | Notes                                                                                                                          |
| -------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v2/datasets/:id/items` shape     | DONE         | Returns array; paginates via `x-apify-pagination-*` response headers.                                                          |
| `?clean=true&format=json` query params | DONE (no-op) | Crawlee Cloud's items endpoint already returns clean JSON; flags accepted but ignored by Fastify (loose querystring handling). |

## Client SDK compat

| Gap                                      | Status  | Notes                                                                                                                        |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `apify-client` SDK pointed via `baseUrl` | PARTIAL | Run-trigger + dataset items verified end-to-end. Other SDK methods (storage CRUD, build operations) not exhaustively tested. |

## How to add a row

When integrating a new client and discovering a new gap:

1. Add a row to the relevant section above with status TODO.
2. If you fix it in the same PR, set status to DONE and reference the changing files.
3. If the divergence is intentional, set status to WONTFIX and document the reason.

This doc is the canonical bookkeeping for cross-platform compat — keep
it in sync with implementation as gaps are closed.
