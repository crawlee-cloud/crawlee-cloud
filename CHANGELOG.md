# Changelog

All notable changes to this project will be documented in this file.

## [0.9.7] - 2026-06-04

### Added

- **API multi-replica safety via Postgres advisory locks (#47).** Adds `withAdvisoryLock(lockId, work)` primitive in `db/index.ts` with a discriminated union `{ acquired: true, result } | { acquired: false }` return shape and a `LOCK_IDS` registry under the `0xC0DE____` namespace. Applies leader election to four background subsystems so they each execute at most once per tick across N replicas:
  - **Retention reaper** — refactored to use the helper (behavior-preserving, ~30 lines of inline lock plumbing removed).
  - **Setup bootstrap** — `setupAdminUser` wrapped in `setupAdminUserGated`. The pre-existing N-replica race that silently accumulated orphan rows in `api_keys` on every deploy (no `UNIQUE(name)` constraint) now goes away.
  - **Scaler** — `scalingLoop` body wrapped; `isScaling` intra-replica fast-path retained; 3-state `wasLeader` edge logging silent at steady state, loud on transitions, and force-clears to `undefined` on errors so the next successful tick re-establishes the edge.
  - **Scheduler** — full rewrite: drops per-schedule `cron.schedule()` registrations and the `activeJobs` map / `register|reload|unregister|unregisterAllSchedules` / `getActiveScheduleCount` exports. Adds `runSchedulerTick` that polls the `schedules` table each `SCHEDULER_TICK_SECS` (default 30s) under `LOCK_IDS.scheduler`, fires due schedules and advances `next_run_at` via `cron-parser` (new dep). Routes pre-compute `next_run_at` at POST time so new schedules are fire-eligible from the next tick.
- **`POST /v2/schedules` cron validation up-front** (#47 follow-up to bot review). PATCH route validates the cron expression _before_ the UPDATE, not after. Previously an invalid cron would persist to the DB and break every subsequent scheduler tick.
- **Re-enable triggers `next_run_at` recompute** (#47 follow-up). Toggling a schedule from `is_enabled=false` → `true` recomputes `next_run_at` so the schedule doesn't fire immediately on a stale past timestamp.

### Fixed

- **Actor `default_run_options.timeoutSecs` / `memoryMbytes` now propagated to runs (#48).** Reported by a user whose scrapers timed out at exactly 3600s despite the actor being configured with `timeoutSecs: 7200`. Two surfaces:
  - `POST /v2/acts/:id/runs` defaulted `timeout = 3600, memory = 1024` at destructure time, never consulting `actor.default_run_options`. Now resolves with fall-through: **request body override → actor config → 3600 / 1024 fallback**.
  - Scheduler's `triggerScheduledRun` omitted `timeout_secs` / `memory_mbytes` from the run INSERT entirely, so scheduled runs always got the DB column defaults regardless of actor config. Now loads `actor.default_run_options` at fire time and binds both columns explicitly. Bails early if the actor was deleted between the schedule firing and the lookup (prevents orphan datasets/KV/queue rows + wasted S3 write).
- **`CreateActorSchema.defaultRunOptions` now caps `timeoutSecs` (≤ 86400s) and `memoryMbytes` (≤ 16384 MB)** to match `ActorRunSchema`'s per-run caps. Previously uncapped — once #48's run propagation landed, an operator could bypass the run-time guardrail by saving `timeoutSecs: 200000` on the actor. Both schemas now enforce the same limits.
- **Advisory-lock SQL parameters explicitly cast to `::bigint`** (#47 follow-up). Lock IDs in the `0xC0DE____` namespace exceed `INT4_MAX`; the explicit cast removes any risk of Postgres picking the `int4` overload and throwing "integer out of range" at runtime.

### Security

- **Plaintext containment on bootstrap race.** Closing the multi-replica setup race also closes a related observability footgun: previously N concurrent replicas each tried to create the admin row and runner-api-key row, with all-but-one failing on the unique-violation. The errors were caught and logged at `setup.ts:115` with the bare error object — depending on the pg driver version, that could include the offending SQL in the error message. The lock removes the race entirely; only one replica ever attempts the insert.

### Migration

- **No schema changes.** Existing `schedules` rows with `NULL next_run_at` get a warm-up backfill on first tick (next_run_at is populated, no firing). Maximum ≤ `SCHEDULER_TICK_SECS` delay before normal firing resumes for pre-upgrade rows only.

### Breaking changes (operational)

- **`GET /health/ready` no longer reports `schedulerJobs`.** The field counted in-process per-schedule cron registrations — a concept that doesn't exist in the new poll-based model. Operators wanting enabled-schedule counts should query the DB directly: `SELECT count(*) FROM schedules WHERE is_enabled = true`.

### Deployment notes

- **`PROXY_ENCRYPTION_KEY` and `SCHEDULER_TICK_SECS` must be set identically on every API replica.** Both processes hard-fail in production without `PROXY_ENCRYPTION_KEY`. `SCHEDULER_TICK_SECS` is optional (default 30); inconsistent values across replicas mean leader-election still works but observed tick cadence varies.
- New deps: `cron-parser@^5` (one transitive-free dep, ~50 kB).
- Documented in `.env.example` and `.env.secure.example`.

PRs in this release: #47 (multi-replica), #48 (actor default timeout).

## [0.9.6] - 2026-06-03

### Added

- **`RUNNER_CLONE_REF` env var on the scaler.** When set, the cloud-init template clones the specified git ref (tag or branch) instead of the default branch. Decouples runner version from upstream `main` merges, so a runner-runtime breaking change on `main` doesn't auto-detonate the next scaler-provisioned droplet. Example: setting `RUNNER_CLONE_REF=v0.9.5` pins all newly-spawned runners to that tag. Unset = unchanged historical behavior (clones default branch). `git clone --branch` refuses bare SHAs by design, so the operator picks tags or branches — not arbitrary commits — which keeps rollback unambiguous.

### Note

- Value is interpolated into the cloud-init bash heredoc unchanged. Same threat model as every other env var the scaler reads — operator-supplied, not user-supplied. A future hardening PR could add a regex guard (`/^[A-Za-z0-9._/-]+$/`) without breaking compat.

## [0.9.5] - 2026-06-03

### Fixed

- **Scaler cloud-init now propagates `PROXY_ENCRYPTION_KEY` to scaled-up runners.** The cloud-init template that bootstraps a freshly-provisioned runner VM (`packages/api/src/scaler/index.ts`) only piped `IMAGE_REGISTRY*` env vars through. In v0.9.4, the runner gained a startup guard that hard-fails in production when `PROXY_ENCRYPTION_KEY` is unset (or, outside production, silently falls back to `sha256(API_SECRET)` — which would not match the API's encrypted records). Either way, scaled-up runners couldn't decrypt actor/user proxy columns. Now passed through alongside the existing registry vars. Single-host deployments are unaffected (operators set the env var directly on the runner process).

### Known gap (not fixed in this patch)

- `APIFY_PROXY_PASSWORD` / `APIFY_PROXY_HOSTNAME` / `APIFY_PROXY_PORT` are NOT yet propagated by the scaler cloud-init. Operators relying on the platform-default proxy tier in scaled deployments will need to extend the passthrough or use per-user / per-actor overrides (which DO work end-to-end on scaled runners after this fix, since they only require the encryption key).

## [0.9.4] - 2026-06-02

### Added

- **Apify Proxy integration (`useApifyProxy=true` now works end-to-end).** Three-tier resolution at run start: per-actor override → per-user setting → platform default env. Actors written against Apify cloud with `proxyConfiguration.useApifyProxy: true` in their input now run unchanged — the SDK's standard env-injection path is preserved (`APIFY_PROXY_PASSWORD/HOSTNAME/PORT` injected only when a password resolves; absent vars activate the SDK's well-tested API fallback to `/v2/users/me`).
- **`GET /v2/users/me` Apify-compat extension.** Switched from no-auth-always-anonymous to `optionalAuth` so the SDK fallback path resolves to the authed user's real proxy. Response embeds `{ proxy: { password, groups: [] } }` only when a password is configured — when unset, the `proxy` field is **omitted entirely** (matches the SDK's non-nullable `UserProxy.password` type, which a literal `null` would type-violate).
- **`PUT /v2/users/me`** (new) and `proxyPassword` field on `PUT /v2/acts/:id` (existing route, extended) — three-state semantics: `undefined` no-op / `null` clears / string encrypts and stores. Asymmetric read/write surface: writes accept the plaintext, reads (`hasProxyPassword` on `/v2/users/me`'s caller-facing dashboard surface, `hasProxyOverride` on the actor row) return only a boolean.
- **`POST /v2/acts`** now persists `proxyPassword` on both create and upsert (the field passed Zod validation but was silently dropped on insert/update in the initial implementation — caught by review).
- **Dashboard panels.** `AUTH · APIFY PROXY` on settings page and `CONFIG · PROXY OVERRIDE` on actor detail. State machine: `[ not configured ] / [ set ]` with replace + revoke (account-level) or remove (per-actor). Write-only credential UI — the plaintext is never rendered, even though `/v2/users/me` returns it for SDK compat.
- **Resilient decrypt.** A corrupted ciphertext or rotated key no longer 500s the SDK fallback or permanently FAILs every run for the affected actor/user. `GET /v2/users/me` server-logs and omits the proxy field; the runner's resolver `safeDecrypt()` skips the affected tier and falls through to the next one so runs proceed (typically without proxy, but at least they run).

### Security

- **AES-256-GCM encryption at rest** for `users.proxy_password_encrypted` and `actors.proxy_password_encrypted` columns. Storage format `v1:<base64-iv>:<base64-ciphertext>:<base64-authtag>` — the `v1:` prefix is the forward-compatibility hook so future key rotations or algorithm changes coexist with stored records without a migration. Per-record random IV (12 bytes, GCM standard), `setAuthTag` before `decipher.final()`, key length enforced.
- **Key source.** `PROXY_ENCRYPTION_KEY` (64 hex chars / 32 bytes) preferred. Dev fallback to `sha256(API_SECRET)` so single-secret deployments work. **Production hard-fails** at API startup (`config-validator.ts`) and at runner startup (`config.ts` guard) if the explicit key is missing — silent fallback in production would cause API/runner key mismatches with broken-but-look-fine behavior. Both processes must use the same value.
- **Robust key validation.** A 64-char non-hex string used to pass the length check, then `Buffer.from(s, 'hex')` would silently truncate at the first non-hex char and yield a < 32-byte AES key — runtime crypto failures despite "successful" startup. Validators now use `/^[0-9a-fA-F]{64}$/`; the crypto helper itself also decode-and-checks `buf.length === 32` for defense in depth.
- **Plaintext containment.** Tests assert encrypted blobs (`/^v1:/` prefix) land in DB call args and the plaintext does not — for `/v2/users/me`, `PUT /v2/acts/:id`, **and** `POST /v2/acts` create + upsert paths. `formatActor()` returns only the boolean projection; the encrypted column never appears in any GET response.

### Migration

- New columns added idempotently: `users.proxy_password_encrypted TEXT NULL` and `actors.proxy_password_encrypted TEXT NULL`. No down-migration needed.

### Deployment notes

- Set `PROXY_ENCRYPTION_KEY` (64 hex chars / 32 bytes) **identically on both the API and runner processes** in production. Both hard-fail at startup without it. Generate with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

### Known limitations / future work

- `/v2/users/me` returns the proxy password of the user the _authenticating token_ is bound to. With the current runner-API-key model (single key, bound to the admin user), the SDK fallback path resolves to the admin's proxy in multi-tenant deployments. The env-injection path — the primary resolution channel — is unaffected. Per-actor-run user binding is a separate effort.
- Custom (non-Apify) `proxyUrls`, per-run override, CLI `crc proxy` subcommand, key rotation tooling, and a pre-flight check that fails fast when `useApifyProxy=true` resolves to no password configured anywhere are all out of scope and tracked as follow-ups.

## [0.9.3] - 2026-06-01

### Added

- **Per-run webhook scope filter on `GET /v2/webhooks`.** New `?scope` query param accepts `catalog` (default — actor-scoped + global, preserves existing operator-catalog behavior), `run` (per-run hooks only), `actor`, `global`, or `all`. Plus two context filters: `?runId=X` (a specific run's hooks) and `?runActorId=X` (per-run hooks across runs of an actor, via a subquery with `user_id` bound inside the subquery so a guessed actor id cannot enumerate another user's hooks). When `runId` or `runActorId` is set, scope auto-defaults to `all` instead of `catalog`. Invalid scopes return 400 with the valid-scope list and short-circuit before any DB query.
- **`webhook_deliveries.request_body` column.** Stores the rendered JSON body actually sent to the receiver on the latest delivery attempt — distinct from `webhooks.payload_template` (which carries unresolved `{{placeholders}}`). Captured on every UPDATE path: success, private-URL refusal, HTTP error retry, network error retry, max-retries-exhausted, and the test endpoint. Persisted in both the runner (`attemptWebhookDelivery`) and the API (test endpoint) — `KEEP IN SYNC` pair.
- **Secret redaction on stored `request_body`.** String values longer than 8 chars whose key matches `/auth|token|password|secret|cookie|signature|hmac|key$/i` are stored as `••• <last4>`. The receiver still gets the unredacted bytes — only the persisted copy is masked. `key$` (suffix-anchored) rather than bare `key` substring so resource id fields like `defaultKeyValueStoreId` are NOT false-positive-masked while credential-style keys (`apiKey`, `secretKey`, `accessKey`) still are. Capped at 4 KB on insert.
- **Run detail page Webhooks tab.** Conditionally rendered when the run has per-run hooks (no dead tab on normal runs). Each hook is a card with headers (credential-like keys auto-masked using the same regex set as redaction), and a per-delivery panel showing **REQUEST BODY · sent** and **RESPONSE BODY · received** side-by-side, pretty-printed when JSON. The configured template only shows as a fallback when no deliveries exist yet — once a delivery exists, the rendered body is strictly more useful.
- **Per-run history sub-section on the actor detail Webhooks tab.** Fed by `?scope=run&runActorId=<actor.id>`. Each row links to the originating run, where full payload + delivery detail is available.
- **Catalog / Per-run tabs on `/webhooks`** with counts (probed via a `limit=1` request on the inactive scope, so the labels stay accurate without paging both lists). Per-run rows link to their originating run. Edit hidden for per-run rows (server rejects PUT on them via the `run_id IS NULL` guard); delete remains as a cancel-pending-delivery affordance.
- **Webhook test button split.** Old "test" fired one synthetic event per subscribed event type — producing delivery logs that looked like a single run had triggered N webhooks, contradicting production semantics (one terminal status per run → one delivery per webhook). Now split into "test" (one event, mirrors production — defaults to the first subscribed event, matching the API's bare-`POST /v2/webhooks/:id/test` behavior) and "test all · N" (one delivery per subscribed event, only rendered for hooks subscribed to 2+ events).
- **Shared `CopyButton` component** at `packages/dashboard/src/components/ui/copy-button.tsx`. Two variants: `inline` (icon-only, for end-of-row placement next to displayed IDs) and `button` (labeled, for the run Input tab JSON viewer). Stops event propagation + prevents default so it works correctly when nested inside a `<Link>` card. Applied across every ID display in the dashboard — actors (list + detail + builds tab + runs tab), builds (list), datasets (list + detail), key-value-stores (list + detail), request-queues (list + detail), runs (list + detail header + aside resource rows), webhooks (list), plus the run Input tab. Every copy passes the full unsliced ID; `.slice()` only affects display.

### Changed

- **Dashboard `/webhooks` page actor fetching hoisted to its own mount-only `useEffect`** instead of re-running on every pagination / search / tab switch. Actors are presentation data (resolving `actor_id` → name for catalog rows), not page data.

### Fixed

- **Defensive error coercion in the webhook-delivery network-error catch.** `(err as Error).message.slice(0, 1024)` would crash with a `TypeError` if a non-`Error` value was thrown (string, null, plain object) — leaving the delivery stuck `PENDING` forever because the catch handler itself threw before reaching `scheduleRetry`. Now wraps via `String(err instanceof Error ? err.message : err).slice(0, 1024)`. Fixed at `packages/runner/src/queue.ts:attemptWebhookDelivery`.

### Tests

- API webhook test count goes from 26 → 31. New coverage: `?scope=run` SQL shape, `?scope=bogus` 400 short-circuit (no DB query issued), `?runActorId` cross-user isolation (`run_id IN (SELECT id FROM runs WHERE user_id = $1 AND actor_id = ...)` bind order pinned by a regex match against the SQL), `?runId` auto-scope-relax.

## [0.9.2] - 2026-05-04

### Fixed

- **CLI: `APIFY_TOKEN` and `APIFY_API_BASE_URL` no longer shadow a saved `crc login`.** `getConfig()` used to fall back from `CRAWLEE_CLOUD_TOKEN` to `APIFY_TOKEN` (and from `CRAWLEE_CLOUD_API_URL` to `APIFY_API_BASE_URL?.replace('/v2', '')`) — an undocumented migration affordance that took precedence over the on-disk profile. In any shell that already had `APIFY_TOKEN` exported (common when the same machine drives both Apify scrapers and a Crawlee Cloud install), `crc login` would succeed because login validates with the `--token` flag directly, and the very next `crc ls` would fail with "Invalid token" because `getConfig()` picked up the foreign Apify token and sent it to the Crawlee Cloud server. The terse "Invalid token" message users saw was the server's response body, faithfully relayed by `list.ts:81`. The CLI now only reads `CRAWLEE_CLOUD_*` env vars; the `APIFY_*` aliases are gone. Fixed at `packages/cli/src/utils/config.ts:getConfig()`.

  **Migration:** anyone implicitly relying on the alias should either run `crc login` once or add `export CRAWLEE_CLOUD_TOKEN=$APIFY_TOKEN` to their shell rc. The runner's injection of `APIFY_TOKEN` / `APIFY_API_BASE_URL` _into actor containers_ (so existing Apify-SDK actors run unmodified on Crawlee Cloud) is untouched — that's a runtime feature, not a CLI auth fallback.

### Added

- **Per-run webhooks** — `POST /v2/acts/:actorId/runs` now accepts a `webhooks[]` array of `{ eventTypes, requestUrl, payloadTemplate?, headersTemplate? }` (max 20). Persisted as rows scoped via the new `webhooks.run_id` column with a `chk_webhooks_scope` CHECK that makes per-run and actor-scoped mutually exclusive, plus `ON DELETE CASCADE`. Admin `GET /webhooks` excludes per-run rows from the operator catalog; `PUT` rejects them; `DELETE` allows them as a cancel-pending-delivery escape hatch. Closes the per-run-webhooks Apify-compat gap (`docs/apify-compatibility.md`).
- **`GET /v2/actor-runs/stats`** — single indexed query returning `total`, `running`, `succeeded`, `failed`, and `failed_last_24h`. Replaces the dashboard's old client-side aggregation that filtered the first page of `/v2/actor-runs` (capped at 50 rows), which silently under-counted past 50 runs total. Failure semantics: `FAILED ∪ TIMED-OUT` (TIMED-OUT is operationally a failure); `ABORTED` stays excluded as operator-cancellation. Locked in by a SQL-content assertion test so the grouping can't silently regress.
- **`GET /v2/actor-runs/histogram?hours=24`** — server-side hourly bucket aggregation via `date_trunc('hour', ...)` + `generate_series` spine + `LEFT JOIN`, returning exactly N rows even for empty hours. The dashboard's "Runs · last 24h" chart now consumes this endpoint instead of building buckets client-side from a 50-row page (which silently dropped older buckets at scale). Same `FAILED ∪ TIMED-OUT` grouping as `/stats` so the chart's red caps and the "Failed · 24h" tile tell the same story.
- **`SUPPORTED_WEBHOOK_EVENTS` const + tightened `eventTypes` Zod enum** for both `CreateWebhookSchema` (admin) and `RunWebhookSchema` (per-run). Subscriptions to `ACTOR.RUN.CREATED` or `ACTOR.RUN.RESURRECTED` (Apify defines them; Crawlee Cloud doesn't fire them yet) now fail with 400 instead of silently never delivering. Gap row in `docs/apify-compatibility.md` tracks the firing TODO for those two events.
- **`--chart [N]` mode in `scripts/seed-stress-fixtures.ts`** — inserts N runs (default 100) with `created_at` jittered across the last 24h, status mix biased ~70% SUCCEEDED with FAILED/TIMED-OUT/RUNNING in the remainder. Lets the histogram be exercised locally without waiting on real activity.

### Fixed

- **Webhook event-type emission matches Apify's wire format.** Apify uses HYPHEN for `run.status` (`'TIMED-OUT'`) but UNDERSCORE for the event type (`'ACTOR.RUN.TIMED_OUT'`); both are intentional. Crawlee Cloud now mirrors both: status strings stay hyphen-form (Apify-canonical), event-type construction translates via `status.replace(/-/g, '_')` at the runner emission seam (`packages/runner/src/queue.ts:387`). Inverse translation in test-webhook delivery for synthetic-run shape parity.
- **Hourly throughput chart rendering bug** — bucket div had no defined height, so the inner bar's `height: %` resolved to 0 against an auto-sized parent (`items-end` on the flex parent prevents the default stretch). Added `h-full` so the bucket fills the parent and percentage heights resolve correctly.
- **Hourly throughput chart math bug** — the FAIL cap was double-scaled: `(failed/total) * h` was applied as a percent of the bar, but the bar was already `h%` of the bucket. Changed to `(failed/total) * 100` so the cap reads as the failure share of the bar.
- **Pre-seeded chart buckets snap to the hour boundary.** Initial `useState` seed used `Date.now()` (subsecond), but the server returns hour-truncated ISO strings — mismatch caused all 24 React keys to change on the first server response, forcing a full bar remount. Now snaps via `setMinutes(0, 0, 0)`.
- **Dashboard polling preserves chart state on transient API failure** rather than clearing the histogram to empty buckets. The previous catch handler returned `{ buckets: [] }` which set the state to empty on every polling glitch; histogram fetch now returns `null` on error and the setter is gated, so the last-known chart stays on screen.
- **`formatBucketHour` uses `Math.floor` instead of `Math.round`** for "Xh ago" labels — buckets are hour-aligned, so the label flip should happen at the next hour boundary, not at the 30-minute mark.
- **Runner no longer overwrites `ABORTED` with `FAILED` when a container kill surfaces as a thrown error.** The success path in `processRun` already had a `WHERE status = 'RUNNING'` guard with an extensive comment explaining the lifecycle invariant ("MUST NOT overwrite if `Actor.fail()` already set it") — but the `catch` block lacked the same guard, so an operator-initiated abort raced against the container's death throes could flip the run back to `FAILED`. The `catch` now mirrors the success path: same guard plus a re-read of the winning status so `triggerWebhooks` fires the right `ACTOR.RUN.*` event (e.g. `ACTOR.RUN.ABORTED`, not `ACTOR.RUN.FAILED`) and `maybeRetryRun` doesn't re-run an aborted job. Fixed at `packages/runner/src/queue.ts:processRun`.
- **`GET /v2/webhooks/:webhookId` now surfaces `runId`** for per-run webhooks. The `WebhookRow` interface always carried `run_id`, but `formatWebhook` omitted it from the response — so operators debugging delivery had to query the DB directly to see which run a webhook was bound to. Always `null` for admin webhooks. Fixed at `packages/api/src/routes/webhooks.ts:formatWebhook`.
- **`/v2/actor-runs/stats` `failed_last_24h` now uses the same hour-aligned 24h window as `/v2/actor-runs/histogram`** (`date_trunc('hour', NOW()) - INTERVAL '23 hours'`) instead of a rolling `NOW() - INTERVAL '24 hours'`. Both endpoints landed in this release; without the alignment, the "Failed · 24h" tile and the histogram's red caps could disagree by up to 59 minutes at the top of every hour. Pinned by an SQL-content assertion test.

### Changed

- **`resource.usageTotalUsd` field** in webhook payloads (always `0`) — Apify-shape parity placeholder until usage tracking lands. Mirrored across `packages/runner/src/queue.ts defaultPayload.resource` and `packages/api/src/routes/webhooks.ts buildWebhookPayload` (KEEP IN SYNC pair).

### Tests

- 269 → 277 passing tests on the api package (16 / 16 unchanged on the runner package). New coverage: per-run webhook INSERT, per-run rejection of unsupported events, admin rejection of unsupported events, stats endpoint shape, stats user-scoping, stats `FAILED ∪ TIMED-OUT` SQL pinning, stats hour-aligned 24h window pinning, histogram shape, histogram bind-param passthrough, histogram out-of-range hours rejection, per-run webhook surfacing `runId` on GET by id.

## [0.9.1] - 2026-05-03

### Added

- **Apify-compatible webhook payload templating engine.** Custom `payload_template` strings now support both forms Apify documents — `"{{eventData}}"` (quoted, the entire string-cell is the variable) and `{{eventData}}` (unquoted, sits as a JSON value) — plus mid-string interpolation (`"text {{userId}} more"`) and dot-notation lookup (`{{eventData.actorRunId}}`, `{{resource.stats.runTimeSecs}}`). Substitution is now against the camelCase Apify-shape payload, not the raw snake_case run row, so templates copied from Apify's docs work unchanged. Implementation: a small character-walker tracks JSON-string state, replaces each `{{...}}` with a sentinel (bare inside strings, JSON-encoded in value position), then JSON.parses and walks the tree to substitute typed values. Engine duplicated in `packages/api/src/webhooks/apply-template.ts` and `packages/runner/src/webhook-template.ts` with `KEEP IN SYNC` headers + 16 + 10 mirrored unit tests; consolidation into a shared workspace lands in v1.0.
- **Test webhook now applies the user's template.** `POST /v2/webhooks/:id/test` previously sent the default Apify-shape payload regardless of the user's `payload_template`. Operators could pass the test webhook and discover production was mangling the template only later. The test endpoint now runs the same engine production deliveries do, so dashboard "test webhook" exercises identical bytes to receivers.
- **Server-side substring search** via `?q=<text>` on `/v2/{acts,datasets,key-value-stores,request-queues,schedules,webhooks}`. ILIKE on `(id, name)` for most resources; actors also search `title, description`; webhooks search `(id, description, request_url)` since they have no `name` column. User-typed LIKE metacharacters (`%`, `_`, `\`) are escaped via a small helper so `?q=100%25` matches the literal string `"100%"` rather than everything. Empty/whitespace `?q=` skips the WHERE clause so the index-only path stays cheap on no-op searches.
- **Dashboard search now hits the API.** The four list pages with existing search inputs (actors, datasets, KV stores, request queues) drop their client-side `Array.filter` (which only filtered the visible 50 rows) and route through the new `?q=` URL param. New `useDebouncedSearch` hook (300 ms) keeps typing responsive without firing a fetch on every keystroke. Setting a new query resets `?page=` so a narrowing search doesn't strand the user on a now-out-of-range page. Search state lives in the URL alongside `?page=` — bookmarkable, shareable, browser back works.
- **Stress-test fixture script** at `scripts/seed-stress-fixtures.ts` — bulk-inserts 5,000 each of unnamed datasets / KV / queues / runs plus 200 actors / 100 schedules / 100 webhooks via `generate_series` for QA at scale. Idempotent on re-run; `--teardown` removes everything with the `stress-` prefix in one pass.

### Fixed

- **Reaper no longer reaps actively-written-to unnamed resources.** v0.9.0's `reap*` predicates only checked `accessed_at`, but data-write paths (`POST /datasets/:id/items`, `PUT /key-value-stores/:id/records/:key`, request-queue mutations) bump `modified_at` only. So an actor pushing data into an unnamed dataset for 31 days could see the dataset reaped while writes were still landing. Each reap predicate now uses `GREATEST(accessed_at, modified_at) < NOW() - $1::int * INTERVAL '1 day'`, which fixes the gap in one place rather than retrofitting every writer.
- **Dashboard counter tiles report the real total** rather than `items.length` capped at 1000. The home dashboard's "Actors" and "Datasets" tiles previously called `getActors({ limit: 1000 })` then reported `actors.items.length` — silently undercounting any tenant past 1,000. They now read `actors.total` from the API's parallel `COUNT(*)`, and the `limit: 1` request makes the call cheaper since the items are unused.

### Changed

- **Search-condition helper extracted to `packages/api/src/db/search.ts`.** The five-line ILIKE clause builder was duplicated across all six list routes; bot-review suggested centralizing. New `appendSearchCondition(where, params, q, columns)` mutates `params` and returns the new WHERE — each route now passes only its searchable columns.

### Tests

- 16 webhook-template engine cases on the api side + 10 on the runner side. Cover both Apify-doc forms (quoted lone-cell, unquoted value-position), mixed quoted/unquoted in one template, mid-string interpolation, dot notation, missing keys (lone → `null`, interpolation → `""`), and invalid-template fallback.
- 6 cases for `escapeLikePattern`, 4 cases for `?q=` on actors, 1 for webhooks (different searchable columns).

## [0.9.0] - 2026-05-03

### Added

- **Retention reaper**: a periodic in-process job that cleans up unnamed datasets, key-value stores, request queues, and finished runs past TTL — the "platform survives months of operation" gating concern. Each tick acquires a Postgres advisory lock on a pinned `pool.connect()` client, runs five SQL phases (runs → datasets → KV → queues → tombstone-prune) bounded by `RETENTION_BATCH_SIZE`, releases the lock, then performs S3 prefix deletion with bounded concurrency. CTE-with-recheck pattern keeps DELETE + tombstone INSERT atomic. New env vars: `RETENTION_ENABLED` (default `true`), `RETENTION_DAYS` (default `30`), `RETENTION_TOMBSTONE_DAYS` (default `365`), `RETENTION_BATCH_SIZE` (default `500`), `RETENTION_CRON` (default `0 3 * * *`).
- **`retention_tombstones` audit table** — every reaped row leaves a tombstone with kind, id, name, user, reason, and original creation timestamp before being pruned at `RETENTION_TOMBSTONE_DAYS`.
- **`GET /v2/system/retention/status`** (admin-only) returns reaper config, last-tick timestamp/elapsed, last-24h reap counts, and live tombstone row count. Backed by Redis tick-stats (cheap to read) plus a single COUNT(\*) over `retention_tombstones`.
- **Dashboard retention status page** at `/retention` with auto-refresh every 30s — surfaces whether the reaper is running, when it last ticked, and what it pruned.
- **Pagination on six dashboard list pages** (actors, datasets, KV stores, request queues, schedules, webhooks) at production scale. Verified against 5,029 datasets / 5,033 KV / 5,029 queues with ~5–12 ms p50 latency on first-page fetches. URL-driven via `?page=N` (1-indexed, omitted on page 1) so pages are bookmarkable, shareable, and editable in the address bar.
- **Page X / Y indicator with editable page-number input** — type a page number, Enter or blur to jump, clamped to `[1, totalPages]`. Out-of-range URLs (`?page=999` on a 12-page list) render an explicit "Page 999 doesn't exist" error with a "go to page N" CTA, distinct from the empty-state UI.
- **Stress-fixture script** (`scripts/seed-stress-fixtures.ts`) — bulk-inserts datasets/KV/queues/runs/actors/schedules/webhooks via `generate_series` for QA at scale. Idempotent on re-run; `--teardown` removes everything with the `stress-` prefix. ~5,000 rows per table land in <300 ms.
- **Deployment recipes** under `docs/deployment/`: a hobby-tier docker-compose recipe and a DigitalOcean Spaces (S3-compatible) recipe, both end-to-end runnable.

### Changed

- **`runs.default_dataset_id` / `default_key_value_store_id` / `default_request_queue_id` FKs softened to `ON DELETE SET NULL`** — previously RESTRICT, which would have blocked the reaper from deleting unnamed default storage of finished runs without a separate cascade pass.
- **Root list endpoints (`/v2/acts`, `/v2/datasets`, `/v2/key-value-stores`, `/v2/request-queues`, `/v2/schedules`, `/v2/webhooks`) now return a real Apify-shape pagination envelope** with `total` from a parallel `COUNT(*)` query, `count`/`offset`/`limit`/`items`. Previously each route hardcoded `LIMIT 100` with no offset and a fake `total = items.length`, which silently truncated for any account with >100 of the resource and made the "have I shown everything?" question unanswerable. Stable `ORDER BY created_at DESC, id DESC` tiebreaker keeps results stable across pages.
- **Dashboard centralizes constants** in `packages/dashboard/src/lib/constants.ts`: `PAGE_SIZE`, `FETCH_ALL_LIMIT`, `LOG_TAIL_LIMIT`, `DATASET_PREVIEW_LIMIT`, `KV_KEYS_PREVIEW_LIMIT`, `POLL_RETENTION_MS`, `POLL_RUNNERS_MS`, `COPY_FEEDBACK_MS`, `APP_VERSION`. Sweeps 7 inline `const LIMIT = 50`, 7 `limit: 1000` magic-number callsites, polling cadences, and the previously-hardcoded `OPERATOR · v0.1` sidebar/login label (now sourced from `package.json`).
- **Retention reaper releases the advisory lock before S3 cleanup**, not after. With `RETENTION_BATCH_SIZE=500` and ~50 ms per S3 LIST+DELETE round-trip, holding the lock through S3 would block sibling-instance DB phases for ~50 s under load — for no benefit, since the rows are already committed when each `reap*()` returns. Each `reap*()` now returns the IDs it deleted; `runReaperTick()` runs the five DB phases under the lock, releases, then runs `cleanupDatasetS3Prefixes` / `cleanupKVStoreS3Prefixes` with bounded concurrency (10).
- **Retention cron callback wraps `runReaperTick()` in `.catch()`.** `pool.connect()` runs outside any try block in the reaper, so a transient DB outage at fire time would otherwise produce an unhandled rejection — fatal under Node 20+'s default `--unhandled-rejections=throw`.

### Tests

- 20 retention integration tests covering each phase, the orchestration tick, advisory-lock contention, the FK softening, and the admin status endpoint (200 for admin, 403 for non-admin).
- 6 config-validation unit tests for the new `envCron` helper and the five retention env vars.

## [0.8.6] - 2026-05-03

### Fixed

- **CLI: `crawlee-cloud push` header now shows the registry-qualified image runners pull**, not the internal local Docker tag. Previously `--ghcr` and `CRAWLEE_CLOUD_REGISTRY_URL` flows printed `crawlee-cloud/actor-<name>:<tag>` (a Docker daemon-only tag never published anywhere) at the top of the push output, while the actual deploy target only appeared mid-stream in the push spinner. CI logs and PR screenshots showed two different images on the same screen with no indication which one the platform actually stores. The header now uses the same `runtimeImage` value that gets sent to the API as `actor.defaultRunOptions.image`.

### Infrastructure

- **`publish-cli.yml` workflow now upgrades npm to a Trusted-Publishing-capable version (>=11.5.1) before publishing.** v0.8.5's first publish attempt 404'd from npm despite a valid OIDC token because Node 20's bundled npm 10.8.2 supports the OIDC handshake for sigstore provenance signing but not for the publish-credential exchange itself, which landed in npm 11.5.1. v0.8.5 was eventually published via a one-time `workflow_dispatch` from a debug branch with the upgrade applied; v0.8.6 will be the first release to take the clean tag-driven publish path end-to-end and confirm the fix.

## [0.8.5] - 2026-05-02

### Fixed

- **API version on the dashboard and `/health` is correct on production deploys.** v0.8.4 and earlier reported `v0.0.0` (or `v1.0.0` on `/health`) when deployed on DigitalOcean App Platform, k8s containers, systemd units, or anywhere `node dist/index.js` is launched directly — `process.env.npm_package_version` is only set by `npm run *` invocations, and the previous fallback masked the missing value as a confidently-wrong version. The API now reads `package.json` from disk at module-load time via a small `version.ts` helper (`dist/version.js → ../package.json`) and serves the result on `/v2/system/info`'s `resource.version` and the legacy `GET /health`. Cached for the process lifetime; falls back to `0.0.0` only if `package.json` is genuinely unreadable (operator-spottable sentinel, not a default for normal operation).

### Documentation

- README now leads with a **Dashboard** section: hero shot of the operator console + a 3×2 grid showcasing Webhooks (test/debug UI), Run detail (live logs, runtime sidebar), Settings (live version, scaler state, storage health probes with latency), KV stores (click-to-expand inline JSON preview), Runs history, and Actors grid. ~900 KB of PNGs under `docs/screenshots/`. Helps prospective adopters evaluate the platform's maturity at a glance from the GitHub page.

### Tests

- New `packages/api/test/version.test.ts` (2 cases): asserts the helper returns the real `package.json` version (not the `0.0.0` fallback), and — using `vi.resetModules()` + dynamic import to actually exercise the load-time codepath — that the value doesn't depend on `process.env.npm_package_version`. Latter test would have caught the production bug at v0.8.0.

## [0.8.4] - 2026-05-02

### Fixed

- **`/v2/system/info` execution defaults now reflect what runners actually use, per scaler provider.** v0.8.3 sourced the panel from API-process env, which is wrong in any split deploy (API and runners on different machines): the API host typically doesn't have `MAX_CONCURRENT_RUNS` / `DEFAULT_MEMORY_MB` / `DEFAULT_TIMEOUT_SECS` set at all, so the dashboard quietly returned the fallback defaults. Now keyed on `SCALER_ENABLED`:
  - **Scaler ON** → memory/timeout come from a per-provider table (`PROVIDER_DEFAULTS` in `scaler/index.ts`) that mirrors what each provider's `createRunner` actually injects:
    - `digitalocean`: 2048 / 3600 (cloud-init writes these explicitly)
    - `local-docker`: 1024 / 3600 (matches the runner's own config fallbacks since the provider only injects `MAX_CONCURRENT_RUNS`)
    - `noop`: 1024 / 3600
    - unknown providers: 1024 / 3600 (honest fallback over a confident lie)
  - **Scaler OFF** → API env (existing behavior, correct for single-host)
- The `2048` / `3600` magic numbers in the DigitalOcean cloud-init heredoc are now `CLOUD_INIT_DEFAULT_MEMORY_MB` / `CLOUD_INIT_DEFAULT_TIMEOUT_SECS` exported constants — used in both the cloud-init template and the system route lookup so they can't drift apart.
- Dashboard "Execution Defaults" footer now reflects the active path (`scaler/cloud-init (split deploy)` vs `API process env (single-host)`) so operators can interpret the values correctly. Field hints simplified — they no longer name specific env vars that may not apply.

### Tests

- 7 system tests now exercise each provider separately: scaler-on + local-docker, scaler-on + digitalocean, scaler-on + unknown provider, scaler-off + single-host. Same bug pattern can't slip back in unnoticed.

## [0.8.3] - 2026-05-02

### Added

- **API: `GET /v2/system/info` endpoint** — aggregate the dashboard's Settings page consumes in one call: server version, Node version, live storage health probes (PostgreSQL / Redis / S3 with latency), execution defaults read from runner env (`MAX_CONCURRENT_RUNS`, `DEFAULT_MEMORY_MB`, `DEFAULT_TIMEOUT_SECS`), and a safe subset of scaler state (enabled, provider, min/max — no IPs, no tokens; full data stays admin-only at `/v2/scaler/status`). Authenticated, not admin-only.
- **Dashboard: new "Server" panel on Settings** showing live version, Node version, scaler state, and queue limits — sourced from `/v2/system/info`.
- **API: `POST /v2/webhooks/:id/test` endpoint** — fires a synthetic event at the webhook's configured URL. One shot, no retries, 10s timeout. Records the result in `webhook_deliveries` so the test attempt shows up in the same history operators already inspect. Payload mirrors the production format but sets `test: true` and uses sentinel run IDs so receivers can opt out of side effects. Returns the delivery row synchronously — UI shows the outcome without polling. Reuses the same private-URL SSRF guard as the runner.
- **Dashboard: webhook test/debug UI on the Webhooks page**:
  - **Test button** on each row fires the new endpoint and toasts the result.
  - **Log button** expands a Deliveries drawer with the last N attempts: status badge, event type, HTTP code, attempt count, age, response/error body, next retry timestamp.
  - **Last-seen indicator** on each row shows status of the most recent delivery once the drawer has been opened (green / red / muted dot).

### Fixed

- **Runner: macOS auto-translate warning is now visible in real time.** Previously the `[Runner] Rewriting actor APIFY_API_BASE_URL host -> host.docker.internal ...` warning was emitted via `console.warn`, which Node line-buffers when stderr is piped to a file (the `npm run start > log 2>&1` case). The warning sat in a buffer until the process exited, so operators triaging a stuck dev setup never saw it during normal operation. Switched to `process.stderr.write(...)`, which Node treats as synchronous on file descriptors and flushes immediately.
- **Runner: removed duplicate `Starting run processor...` boot log.** Both `index.ts` and `queue.ts:startProcessing()` were logging the same line, producing two consecutive identical entries on every boot. Kept the one inside `startProcessing()` since it's closer to the action it announces.
- **Dashboard: Storage Backends section no longer lies.** Previously rendered a hard-coded list of three backends (`PostgreSQL` / `Redis` / `MinIO`) all unconditionally tagged `connected`, regardless of whether the underlying service was reachable. Now reads live `storage` health from `/v2/system/info` and shows `connected` (with latency), `down` (with the failure reason on hover), or `checking` while the request is in flight.
- **Dashboard: Execution Defaults are now real.** The three input fields (concurrency, memory, timeout) previously rendered hard-coded JSX literals (`defaultValue={10}`, `{1024}`, `{3600}`) regardless of server config — the footer text claimed "server-driven values" but they came from nowhere. Now read from `/v2/system/info`'s `executionDefaults`, sourced from `MAX_CONCURRENT_RUNS` / `DEFAULT_MEMORY_MB` / `DEFAULT_TIMEOUT_SECS` env vars. Read-only; stays read-only — these stay env-var-driven for now (writeable defaults would need a settings store and admin-only mutation route).
- **API: `GET /v2/auth/api-keys` now returns camelCase fields.** Previously the route returned raw Postgres rows (`is_active`, `key_preview`, `last_used_at`), but the dashboard's `ApiKey` interface — and the rest of the API surface — uses camelCase. Result: `apiKeys.filter(k => k.isActive)` evaluated to `[]` for every key, hiding every active token from the Settings page. The list is now mapped through the same camelCase shape `formatWebhook`/`formatDelivery` use.
- **Dashboard: `getWebhookDeliveries()` now hits the right URL.** The helper was calling `/v2/webhooks/:id/dispatches` (wrong path) and silently catching the 404 to return `[]`, which made the deliveries list permanently empty even when records existed. Path corrected to `/v2/webhooks/:id/deliveries` and the swallowed try/catch removed so failures surface.
- **Dashboard: `WebhookDelivery` type now matches what the API actually returns.** Previously declared `statusCode` / `errorMessage` / `deliveredAt` — fields the API never returned. Real shape is `status` (PENDING/DELIVERED/FAILED), `attemptCount`, `maxAttempts`, `nextRetryAt`, `responseStatus`, `responseBody`, `finishedAt`. Locked into the type so the new drawer renders real values instead of `undefined`.

### Refactored

- `packages/api/src/health.ts`: extracted `runStorageHealthChecks()` and `StorageHealth` type so `/health/ready` (k8s probe) and `/v2/system/info` (dashboard) share one implementation. Single source of truth for what "healthy" means across surfaces.

### Verified

- Re-ran the local smoke test against the cuponation actor with `API_BASE_URL=http://localhost:3000` (the bad value the auto-translate is meant to handle). Warning now appears in `/tmp/crc-runner.log` on the next run, before the container is created. Run completed `SUCCEEDED` with the actor reaching the host API via `host.docker.internal`.

## [0.8.2] - 2026-05-02

### Fixed

- **Runner: actor containers can now reach a host-running API on macOS dev setups.** When the runner runs on the host (the default `npm run dev` flow on a Mac) and spawns an actor container with `APIFY_API_BASE_URL=http://localhost:3000`, the actor previously failed because `localhost` inside the container is the container itself, not the host. The runner now auto-translates `localhost` and `127.0.0.1` to `host.docker.internal` on `os.platform() === 'darwin'` only — Linux is untouched, since `host.docker.internal` doesn't resolve there by default and production Linux deploys typically use a real service hostname. A one-time warning logs the rewrite so operators understand what's happening.
- **Scaler: heartbeats now match by runner _name_ as a fallback, not just _id_.** Cloud-init can't always set `RUNNER_ID` to the provider id at boot (curl to the metadata service can fail, or the user-data path is racy). When that happens, the runner publishes its heartbeat keyed on `os.hostname()` — which providers typically set to the runner _name_ (DO droplet name, local-docker container name), not the id. Previously the scaler matched only by id and ip, so every healthy runner was marked dead after the reaper threshold and destroyed. Lookup is now `id → ip → name`. The DO cloud-init also opportunistically queries the metadata service for the droplet id and writes `RUNNER_ID=<id>` so the primary match works whenever the metadata fetch succeeds.
- **Local-docker provider: strip the leading `/` from container names** so the value matches what `os.hostname()` returns inside the container (Docker prefixes `Names[0]` with `/`).

### Added

- **API: `GET /v2/actor-runs/:runId/log` (Apify-compat alias).** Returns the same plain-text payload as the canonical `/logs/raw` route. Apify's documented public endpoint is the singular form; tools like `apify-client` and curl scripts targeting `api.apify.com` now work unchanged when pointed at a self-hosted instance.

### Documentation

- `.env.example` now covers `API_BASE_URL` with explicit guidance for macOS dev (auto-translation), docker-compose (service name), and production (public DNS).

### Tests

- Added `packages/runner/test/translate.test.ts` covering Darwin auto-translation, Linux pass-through, and non-loopback hosts. Runner package now has a `test` script wired to vitest.
- Added `/log` alias coverage in `packages/api/test/logs.test.ts` — verifies it returns identical bytes to `/logs/raw` and shares the same ownership 404 gate.

## [0.8.1] - 2026-05-01

### Security

- **Scaler: TLS verification is no longer disabled by default on provisioned runners.** Previously `NODE_TLS_REJECT_UNAUTHORIZED=0` was hard-coded into the cloud-init script, making every outbound HTTPS call from a runner (API, S3, registries, actor scraping) MITM-vulnerable. The bypass is now opt-in via `SCALER_INSECURE_TLS=true`, and the API logs a startup warning when set. Operators relying on internal CAs / self-signed certs must explicitly opt in; otherwise upgrade is transparent.
- Documented the cloud-init userData secret-exposure caveat: on `digitalocean` provider, `DATABASE_URL`, `REDIS_URL`, and registry tokens are inlined into user_data and readable from the DO metadata service by anything running on the VM. Tracked for an architectural fix in a future release; documented today so operators can apply network-level mitigations.

### Performance

- Replaced `redis.keys('runner:heartbeat:*')` with cursor-based `SCAN` in both `getActiveRunners` and `getScalerStatus`. `KEYS` is O(N) over the entire keyspace and blocks the Redis event loop — fine in tests, lethal on a shared Redis at scale.

### Fixed

- Scaler no longer over-provisions on transient `provider.listRunners()` failures. Previously the error was swallowed and an empty list returned, causing the scaler to think capacity was zero and create duplicate runners on the next tick. Errors now propagate to the loop's catch block, which logs and skips the tick.
- `loadScalerConfig` rejects non-finite integer env vars (e.g. `SCALER_MAX_RUNNERS=abc`) and falls back to defaults instead of producing `NaN` and silently breaking comparisons. `MAX_RUNNERS` is also clamped to `>= MIN_RUNNERS`.
- `LAST_ACTIVITY_KEY` now has a TTL (4× `idleTimeoutSecs`) so it ages out of Redis if the scaler is later disabled, rather than living forever.
- `RUNNERS_KEY` TTL adapts to `pollIntervalSecs` (`max(120, pollIntervalSecs * 4)`). Previously hard-coded to 120s, which caused `getScalerStatus` to report an empty runner list when the poll interval exceeded 30s.

### Documentation

- Added an Auto-scaling section to `docs/runner.md` covering every `SCALER_*` env var, provider matrix, and operational notes.
- `.env.example` and `.env.secure.example` now document the full scaler config surface, with `SCALER_INSECURE_TLS` and `METRICS_PUBLIC` flagged as security opt-outs.

## [0.8.0] - 2026-05-01

### Breaking

- `GET /metrics` is now admin-only by default. Previously unauthenticated, the endpoint exposed process internals and per-route HTTP counters useful for fingerprinting a deployment. Self-hosted operators scraping `/metrics` with Prometheus must update their scrape config to send an admin JWT (or admin API key) in the `Authorization: Bearer ...` header. `/health`, `/health/live`, and `/health/ready` remain unauthenticated for k8s probes. Set `METRICS_PUBLIC=true` to opt out (see Added below).
- `GET /v2/scaler/status` is now admin-only with no opt-out — the response includes runner IPs, cloud provider, and scaler config that have no public use case.

### Added

- **Auto-scaling**: new `local-docker` scaler provider for development and small self-hosted setups; reaper sweeps dead runners; image registry support (GHCR, Docker Hub) so new runners pull actor images on demand instead of requiring a local build.
- **Build versioning**: actor versions and builds are tracked separately, with a partial unique index on `actor_versions(actor_id, build_tag)` to allow multiple builds per tag while keeping the active one unique.
- **Run pagination**: scale-aware, stable pagination for run listings — keyset-based, holds steady under high write volume.
- **CLI profiles**: `crc login --profile <name>` saves named credential sets; `crc profile list/use/rm` and `CRAWLEE_CLOUD_PROFILE=...` env override let you switch between local/staging/prod without re-logging-in.
- **CLI `crc info`**: shows active profile, API URL, server reachability, and authenticated user. Exits non-zero on failure — usable as a CI gate.
- **Actor default env vars and image** in `defaultRunOptions` — set per-actor defaults that apply to every run unless overridden at run time.
- **Dashboard pages**: Builds, Schedules, Webhooks, Request Queues, Runners, Key-Value Store browser, mobile nav, toast/dialog/confirm UI primitives.
- `METRICS_PUBLIC` env var (default `false`) — opt-in escape hatch for operators running Prometheus on a private network where the scrape job can't pass an `Authorization` header. When `METRICS_PUBLIC=true` and `NODE_ENV=production`, the API logs a startup warning. There is intentionally no equivalent flag for `/v2/scaler/status`.

### Changed

- Documentation moved from the website repo to `docs/` in this repo as the source of truth, with sync to the public site.
- Dashboard migrated to Tailwind v4 utility names (`bg-signal`, `text-fail`, ...) and a unified warm-orange `--signal` color across themes.
- ESLint: pedantic rules softened, real-bug rules kept strict.

### Fixed

- `apify-client` 404 contract: API responses now include `error.type='record-not-found'` so `catchNotFoundOrThrow` correctly falls through to `getOrCreate`.
- Runner API key is regenerated when bound to a stale user, fixing a 404-on-own-storage failure mode after admin changes.
- `PUT /v2/acts/:id` now persists `defaultRunOptions`, `maxRetries`, and `retryDelaySecs` correctly.
- Dataset items return type narrowed at the consumer rather than the helper, unblocking dashboard CI.
- Runner prefixes `actor-` when pulling from a configured registry, matching the build naming convention.

## [0.1.0] - 2025-12-14

### Added

#### Infrastructure (Sep 28)

- Docker Compose orchestration for PostgreSQL, Redis, and MinIO
- Separate dev and production configurations
- Dockerfiles for API, Runner, and Actor base images

#### API Server (Oct 5 - Oct 18)

- Fastify server with Apify-compatible REST API
- Dataset CRUD operations (`/v2/datasets`)
- Key-value store support (`/v2/key-value-stores`)
- Request queue with deduplication (`/v2/request-queues`)
- Actor management routes (`/v2/acts`)
- Run execution and status (`/v2/actor-runs`)
- JWT authentication system
- PostgreSQL integration for metadata
- Redis for distributed locking
- S3-compatible blob storage

#### Runner (Oct 26)

- Docker-based Actor execution
- Job queue polling from Redis
- Container lifecycle management
- Log streaming to API
- Resource limits and graceful shutdown

#### Dashboard (Nov 9 - Dec 6)

- Next.js application with App Router
- Actor listing and management UI
- Run execution with live logs
- Dataset browser
- Settings page
- Responsive sidebar navigation

#### CLI (Nov 22)

- `crawlee-cloud login` - Server authentication
- `crawlee-cloud push` - Push Actors to registry
- `crawlee-cloud run` - Execute Actors with input
- `crawlee-cloud logs` - Real-time log streaming

#### Documentation (Dec 13)

- Complete API reference
- CLI usage guide
- Dashboard overview
- Deployment instructions
- Runner configuration guide

### Features

- WebSocket streaming for real-time logs
- Request queue deduplication by `uniqueKey`
- Distributed locking for multiple workers
- Cloud-agnostic S3-compatible storage
