# MCP e2e harness

Opt-in end-to-end test that drives the unmodified
[`@apify/actors-mcp-server`](https://github.com/apify/apify-mcp-server) over
stdio against a running Crawlee Cloud stack, and checks every tool the MCP
parity epic (#106) relies on.

It is a standalone package, not an npm workspace: its dependencies stay out of
the root install, `npm test` and Turborepo. It needs Docker, a runner and
network access, so it does not run in default CI.

```bash
E2E_API_URL=http://localhost:3000 E2E_TOKEN=cp_xxx npm run test:mcp-e2e
```

## What it does

1. Reads your username from `GET /v2/users/me`. The per-actor tool name is
   derived from it the same way the MCP server does (`.` becomes `-dot-`).
2. Pushes `fixture-actor/` (`echo-scraper`) with the built CLI
   (`packages/cli/dist/bin.js`). `CRAWLEE_CLOUD_REGISTRY_URL` is set to empty so
   a `registryUrl` in your CLI profile does not trigger a `docker push`; your
   CLI config is not modified.
3. Starts `proxy.mjs`, a logging proxy between the MCP server and the API.
   Every request is written to `.out/http.log` (method, path, status, and the
   error body for 4xx/5xx).
4. Spawns `npx -y @apify/actors-mcp-server@0.17.3 --tools
actors,runs,storage,get-actor-list,<username>/echo-scraper` with a clean
   environment (`APIFY_API_BASE_URL` pointing at the proxy, `APIFY_TOKEN`,
   `TELEMETRY_ENABLED=false`, `PATH`, `HOME`). The server reads options from
   unprefixed env vars (`TOOLS`, `ACTORS`, `UI_MODE`, `APIFY_IS_AT_HOME`), so
   the parent environment is never passed through. Server stderr goes to
   `.out/mcp-server.log`.
5. Runs the checks and prints a PASS/FAIL line per check plus a summary.

The read checks (`get-actor-run`, storage tools, ...) use the run created by
`call-actor`. If `call-actor` fails, the harness starts the same run through the
REST API instead, so the read tools are still exercised on their own.

### Checks

| Check                        | What passes                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `tools-list`                 | `tools/list` contains `<username>--echo-scraper` with `query` required         |
| `search-actors`              | finds `echo-scraper`                                                           |
| `fetch-actor-details`        | returns the input schema with `query` required                                 |
| `get-actor-list`             | lists `echo-scraper`                                                           |
| `call-actor`                 | waits (`waitSecs: 45`), run `SUCCEEDED`, 4 dataset items                       |
| `poll-count`                 | fewer than 100 `GET /v2/actor-runs/:id` requests during that `call-actor`      |
| `actor-tool`                 | the generated `<username>--echo-scraper` tool runs to `SUCCEEDED` with 2 items |
| `get-actor-run`              | returns the run, `SUCCEEDED`, with its default dataset id                      |
| `get-actor-run-list`         | lists the run                                                                  |
| `get-actor-run-log`          | log contains the fixture's output                                              |
| `get-dataset`                | id matches, `itemCount` is 4                                                   |
| `get-dataset-items`          | `limit: 2`, `fields: "title"` returns 2 items with only `title`                |
| `get-dataset-schema`         | inferred schema has `rank`, `title`, `price`                                   |
| `get-dataset-list`           | lists the run's default dataset                                                |
| `get-key-value-store`        | id matches                                                                     |
| `get-key-value-store-keys`   | contains `OUTPUT`                                                              |
| `get-key-value-store-record` | `OUTPUT` record carries the run's query                                        |
| `get-key-value-store-list`   | lists the run's default store                                                  |
| `abort-actor-run`            | `call-actor` with `waitSecs: 0`, then abort; run ends `ABORTED`                |

### Expected failures

`expected-failures.json` lists the checks that are allowed to fail. The command
exits non-zero when:

- a check fails that is not listed, or
- a listed check passes ("unexpectedly passed, remove from
  expected-failures.json"), so the list can only shrink.

Since the MCP parity epic (#106) closed, the list is empty (`[]`): every check
must pass, and any regression fails the run. Do not add a check back to the list
to make a run pass; fix the regression or open an issue.

## Stack prerequisites

- **Node 22+** for the harness. The MCP server exits on older Node. The rest of
  the repo still targets Node 20.
- **Infrastructure**: `npm run docker:dev`. It also creates the default
  `crawlee-cloud` bucket; create it by hand if you set a different `S3_BUCKET`.

- **Build**: `npm run build`. The CLI is run from `packages/cli/dist/`.
- **API and runner running** (`npm run db:migrate`, then start both). Set the
  runner's `DOCKER_NETWORK` to the dev compose network, which is
  `<checkout dir>_default` (for example `crawlee-platfrom_default`). The default
  `crawlee-cloud_default` only matches a checkout directory named
  `crawlee-cloud`.
- **Linux**: actor containers cannot reach `localhost:3000` on the host. On
  macOS the runner rewrites `localhost` to `host.docker.internal`
  (`packages/runner/src/docker.ts`); on Linux it does not. Set the runner's
  `API_BASE_URL` to an address containers can reach, for example the Docker
  bridge gateway (`API_BASE_URL=http://172.17.0.1:3000`), and make sure the API
  listens on that interface.
- **An API key** with the `cp_` prefix (dashboard Settings, or
  `POST /v2/auth/api-keys` with a login JWT).

## Environment

| Variable        | Required | Meaning                                                           |
| --------------- | -------- | ----------------------------------------------------------------- |
| `E2E_API_URL`   | yes      | API base URL, without `/v2` (for example `http://localhost:3000`) |
| `E2E_TOKEN`     | yes      | `cp_` API key                                                     |
| `E2E_SKIP_PUSH` | no       | `1` reuses the already pushed fixture (skips the Docker build)    |

## Output

Everything is written to `.out/` (gitignored):

- `http.log`: one line per request the MCP server made
- `mcp-server.log`: MCP server stderr
- `push.log`: `crc push` output

## Bumping the MCP server

The server version is pinned in `run.mjs` (`MCP_SERVER_PACKAGE`) and releases
often. Bump it on purpose, in its own PR, together with the
`@modelcontextprotocol/sdk` version in `package.json` (keep it equal to the
version the server pins).
