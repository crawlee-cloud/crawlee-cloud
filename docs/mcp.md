# MCP (AI agents)

Crawlee Cloud works with the stock [Apify MCP server](https://github.com/apify/apify-mcp-server)
(`@apify/actors-mcp-server`, MIT). Point it at your instance with
`APIFY_API_BASE_URL` and an AI agent such as Claude or Cursor can find your
actors, run them, check runs, and read datasets and key-value stores through the
[Model Context Protocol](https://modelcontextprotocol.io).

There is no MCP server to install on the platform. The Apify server runs on the
agent's machine (stdio) and calls your API like any `apify-client` program.
This page covers version `0.17.3` of the server, the version the
[MCP e2e harness](https://github.com/crawlee-cloud/crawlee-cloud/tree/main/tests/mcp-e2e)
checks against. Newer versions usually work, but pin a version you have tested.

## Requirements

- A Crawlee Cloud API with MCP support (the release after v1.6.0).
- **Node.js 22 or later** on the machine that runs the agent. The Apify server
  exits on older Node versions.
- An API key (`cp_...`). Create one per agent: see [Security](#security).
- Your **username** (see [Find your username](#find-your-username)) if you want
  per-actor tools.
- For per-actor tools with typed parameters, actors pushed with a CLI that
  uploads the input schema (`crc push` in the same release). Actors pushed
  earlier still run, but their tools have no parameter schema until you push
  them again.

## What works

Always pass `--tools`. Without it, the server loads its default set, `actors,docs`,
plus two Apify Store actors (`apify/rag-web-browser`, `apify/web-fetch`) that
do not exist on your instance.

| `--tools` entry      | Tools                                                                                                                                                                                     | Notes                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `actors`             | `search-actors`, `fetch-actor-details`, `call-actor`                                                                                                                                      | `search-actors` searches **your own** actors (`GET /v2/store`); there is no public store. |
| `runs`               | `get-actor-run`, `get-actor-run-list`, `get-actor-run-log`, `abort-actor-run`                                                                                                             |                                                                                           |
| `storage`            | `get-dataset`, `get-dataset-items`, `get-dataset-schema`, `get-dataset-list`, `get-key-value-store`, `get-key-value-store-keys`, `get-key-value-store-record`, `get-key-value-store-list` |                                                                                           |
| `get-actor-list`     | `get-actor-list`                                                                                                                                                                          | Not in any category; name it explicitly.                                                  |
| `<username>/<actor>` | one tool per actor, named `<username>--<actor>`                                                                                                                                           | Parameters come from the actor's input schema. Calling it runs the actor and waits.       |

A recommended setting:

```text
--tools actors,runs,storage,get-actor-list,alice/my-actor,alice/other-actor
```

All 18 checks of the e2e harness (`npm run test:mcp-e2e`) pass with this set:
every tool above, a real container run started by `call-actor` and by the
per-actor tool, and an abort.

## Setup

Every snippet below sets the same three environment variables:

| Variable             | Value                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| `APIFY_API_BASE_URL` | Your API's base URL, **without** `/v2`, e.g. `https://crawlee.example.com`     |
| `APIFY_TOKEN`        | A Crawlee Cloud API key (`cp_...`)                                             |
| `TELEMETRY_ENABLED`  | `false`. Otherwise the server sends usage analytics and error reports to Apify |

Replace `alice/my-actor` with your own `username/actor-name` entries, or drop it.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config; on macOS
`~/Library/Application Support/Claude/claude_desktop_config.json`, on Windows
`%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "crawlee-cloud": {
      "command": "npx",
      "args": [
        "-y",
        "@apify/actors-mcp-server@0.17.3",
        "--tools",
        "actors,runs,storage,get-actor-list,alice/my-actor"
      ],
      "env": {
        "APIFY_API_BASE_URL": "https://crawlee.example.com",
        "APIFY_TOKEN": "cp_xxx",
        "TELEMETRY_ENABLED": "false"
      }
    }
  }
}
```

Claude Desktop starts `npx` with its own `PATH`. If it picks up a Node version
older than 22, set `"command"` to the absolute path of a Node 22 `npx`.

### Claude Code

```bash
claude mcp add --transport stdio \
  --env APIFY_API_BASE_URL=https://crawlee.example.com \
  --env APIFY_TOKEN=cp_xxx \
  --env TELEMETRY_ENABLED=false \
  --scope user \
  crawlee-cloud \
  -- npx -y @apify/actors-mcp-server@0.17.3 \
  --tools actors,runs,storage,get-actor-list,alice/my-actor
```

Everything after `--` is the server command. Keep another option (here
`--scope user`) between the last `--env` and the server name, or the name is read
as one more `KEY=value` pair. Use `--scope project` to write a shared
`.mcp.json` instead, but do not commit a token. Check the connection with
`claude mcp list` or `/mcp` inside Claude Code.

### Cursor

Create `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for all
projects):

```json
{
  "mcpServers": {
    "crawlee-cloud": {
      "command": "npx",
      "args": [
        "-y",
        "@apify/actors-mcp-server@0.17.3",
        "--tools",
        "actors,runs,storage,get-actor-list,alice/my-actor"
      ],
      "env": {
        "APIFY_API_BASE_URL": "https://crawlee.example.com",
        "APIFY_TOKEN": "cp_xxx",
        "TELEMETRY_ENABLED": "false"
      }
    }
  }
}
```

Add `.cursor/mcp.json` to `.gitignore` if it holds a real token.

### Other clients

Any MCP client that can start a stdio server works the same way: run
`npx -y @apify/actors-mcp-server@0.17.3 --tools ...` with the three environment
variables above.

## Find your username

Per-actor tools are addressed as `<username>/<actor-name>`. Your username is a
slug derived from your email's local part (`alice@example.com` → `alice`; a
second `alice@...` gets `alice-2`). It is not your email.

- **Dashboard**: Settings → API access → **Username**.
- **API**:

  ```bash
  curl -s -H "Authorization: Bearer $TOKEN" https://crawlee.example.com/v2/users/me \
    | jq -r .data.username
  ```

Usernames cannot be changed yet.

## Known limits

- **Links point to `apify.com`.** Tool output includes links such as
  `https://apify.com/<username>/<actor>` and Apify Console URLs. They are
  hardcoded in the Apify server and do not lead to your instance. Use the IDs
  in the output with your dashboard instead.
- **Unsupported categories**: `tasks`, `schedules`, `builds`, `source` and `dev`
  call endpoints Crawlee Cloud does not implement, or implements differently.
  Do not enable them. `docs` works, but it searches **Apify's** documentation,
  not the Crawlee Cloud docs.
- **Standby and MCP-proxy actors** are not supported. Crawlee Cloud has no
  Standby mode, so every actor is exposed as a normal run-and-wait tool.
- **Large binary key-value records** (over 256 KB) are returned as a link built
  by `apify-client` on `api.apify.com`, not on your base URL. Smaller binary
  records, JSON and text are returned inline and work.
- **Per-actor tool names** are `<username>--<actor name>`. A `.` in the
  username would become `-dot-`, but usernames never contain one. A `.` in the
  actor name is kept, and some clients only accept tool names made of letters,
  digits, `_` and `-`: avoid dots in the names of actors you expose as tools.
  Names longer than 64 characters are cut and given a 4-character hash suffix,
  so keep `username` + `actor name` under 62 characters for readable tool names.
- **`call-actor` waits at most 45 s** (its `waitSecs`). Longer runs keep going;
  the agent can poll them with `get-actor-run`. The API holds each wait request
  for at most 60 s; see [`waitForFinish`](./apify-compatibility.md#waiting-for-runs-and-builds)
  for proxy timeouts.
- **Node 22+** is required by the Apify server (see [Requirements](#requirements)).
- **Telemetry**: the Apify server sends usage analytics (Segment) and error
  reports (Sentry) to Apify unless `TELEMETRY_ENABLED=false` is set (or
  `--telemetry-enabled=false` is passed). Every snippet on this page disables it.

## Security

- **The token has your full API access.** API keys have no scopes yet: an agent
  holding one can start and abort runs, read every dataset and store you own, and
  delete actors (the server also has an opt-in `delete-actor` tool; do not add it
  to `--tools` unless you mean to).
- **Use a dedicated API key per agent**, created in the dashboard (Settings → API
  access). Name it after the agent, and revoke it there when you stop using the
  agent or suspect a leak. Revoking one key does not affect the CLI or other agents.
- **Keep tokens out of shared files.** The config files above hold the token in
  plain text; do not commit them.
- **Query strings.** `apify-client` sends run options in the query string,
  including `envVars` and `webhooks` (base64 JSON), and `?token=` is accepted for
  authentication. The API redacts these three parameters from its own request
  logs, but a reverse proxy or load balancer in front of it still logs raw URLs
  unless you configure it not to.

## Troubleshooting

- **`search-actors` or `get-actor-list` finds nothing**: actors are scoped to the
  API key's user. Check that the key belongs to the user who pushed the actors.
- **Per-actor tool missing from the tool list**: check the `--tools` entry uses
  your username (not your email) and the exact actor name, and that the actor has
  a successful build (`crc push` creates one).
- **Per-actor tool has no parameters**: the actor was pushed before input schemas
  were uploaded. Push it again with the current CLI; `crc push` prints
  `Input schema: <path>`.
- **A request is cut off after ~60 s**: a proxy in front of the API times out
  long-polling requests; raise its read timeout above 60 s.

See also: [Apify API compatibility](./apify-compatibility.md) for the endpoint
behaviour the server relies on, and the RFC discussion
[#96](https://github.com/orgs/crawlee-cloud/discussions/96) for what comes next
(a native MCP endpoint and OAuth).
