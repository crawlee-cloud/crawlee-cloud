# CLI Guide

The Crawlee Cloud CLI provides command-line tools for managing Actors.

## Installation

```bash
npm install -g @crawlee-cloud/cli
```

Or use directly with npx:

```bash
npx @crawlee-cloud/cli <command>
```

After installation, you can use either `crawlee-cloud` or the short alias `crc`:

```bash
crawlee-cloud <command>
# Or the short alias
crc <command>
```

---

## Commands

### `init`

Create a new Actor project from a template.

```bash
crawlee-cloud init [name] [options]
```

**Options:**

| Flag             | Description                    |
| ---------------- | ------------------------------ |
| `--template, -t` | Template ID from Apify catalog |
| `--list, -l`     | List available templates       |

**Example:**

```bash
# Interactive mode - prompts for name and template
crawlee-cloud init

# Quick start with specific template
crawlee-cloud init my-scraper --template ts-crawlee-cheerio
```

---

### `dev`

Run an Actor locally in development mode.

```bash
crawlee-cloud dev [options]
```

**Options:**

| Flag          | Description                        |
| ------------- | ---------------------------------- |
| `--watch, -w` | Enable file watching & auto-reload |

**Example:**

```bash
cd my-actor
crawlee-cloud dev           # Run once
crawlee-cloud dev --watch   # Run with hot reload
```

---

### `status`

Check the status of an Actor run.

```bash
crawlee-cloud status <run-id> [options]
```

**Options:**

| Flag             | Description                            |
| ---------------- | -------------------------------------- |
| `--watch, -w`    | Watch for status updates               |
| `--interval, -i` | Watch interval in seconds (default: 5) |

**Example:**

```bash
crawlee-cloud status abc123
crawlee-cloud status abc123 --watch --interval 5
```

---

### `login`

Authenticate with your Crawlee Cloud server.

```bash
crawlee-cloud login [options]
```

**Options:**

| Flag            | Description                                               |
| --------------- | --------------------------------------------------------- |
| `--url, -u`     | API base URL                                              |
| `--token, -t`   | API token                                                 |
| `--profile, -p` | Save under a named profile (for multi-environment setups) |

Without flags, you'll be prompted interactively. The token is validated against the server before saving — invalid tokens never get persisted.

**Examples:**

```bash
# Interactive login (prompts for URL and token)
crawlee-cloud login

# Non-interactive
crawlee-cloud login --url https://your-server.com --token your-api-token

# Save under a named profile (sets it as active too)
crc login --profile prod    --url https://crc.prod.example.com  --token <T>
crc login --profile staging --url https://crc.staging.example   --token <T>
crc login --profile local   --url http://localhost:3000         --token <T>
```

Credentials are stored in `~/.crawlee-cloud/config.json`. The file uses a multi-profile shape; legacy single-profile configs are migrated transparently on first read.

---

### `info`

Show the active profile, API URL, server status, and authenticated user. The "where am I?" command for context-switching between environments.

```bash
crawlee-cloud info [-j, --json]
```

**Output (human-readable):**

```
Profile:    prod (active)
API:        https://crc.prod.example.com
Server:     v0.1.0  reachable, 53ms
Auth:       valid
User:       amine@example.com  (admin)
Token:      eyJhbGciOiJI...
```

**Exits non-zero** if the server is unreachable or the token is invalid — useful as a CI healthcheck before `crc push`:

```bash
crc info --json >/dev/null && crc push
```

The `--json` output (short flag: `-j`) has a stable shape suitable for piping into scripts. The full token is never exposed; only a 12-char preview.

---

### `profile`

Manage saved login profiles. A profile is a stored `apiBaseUrl + token` pair; one is active at a time. Use `crc login --profile <name>` to create one.

```bash
crawlee-cloud profile list           # show all profiles, mark active (alias: ls)
crawlee-cloud profile use <name>     # switch active
crawlee-cloud profile rm  <name>     # delete a profile (alias: remove)
```

**Examples:**

```bash
$ crc profile list
  local    http://localhost:3000        eyJhbGciOiJI...
  staging  https://crc.staging.example  eyJhbGciOiJI...
* prod     https://crc.prod.example     eyJhbGciOiJI...

$ crc profile use staging
✅ Active profile is now "staging"
```

For per-invocation overrides without changing the active profile, use the `CRAWLEE_CLOUD_PROFILE` env var:

```bash
CRAWLEE_CLOUD_PROFILE=prod crc push    # one-off push, no `profile use` needed
```

---

### `push`

Build and push an Actor to the registry. The command takes no positional argument — the Actor name is always read from `.actor/actor.json` in the current directory.

```bash
crawlee-cloud push [options]
```

**Options:**

| Flag           | Description                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| `--tag, -t`    | Docker image tag for the build (default: `latest`)                                   |
| `--no-build`   | Skip local build step                                                                |
| `--platform`   | Docker build platform (e.g. `linux/amd64`)                                           |
| `--remote`     | Build on a remote runner via SSH (`user@host`)                                       |
| `--ssh-key`    | SSH key to use for the remote build                                                  |
| `--ghcr`       | Build and push to GitHub Container Registry (e.g. `org/repo`)                        |
| `--ghcr-user`  | GHCR username (default: `github`)                                                    |
| `--ghcr-token` | GHCR token (or set the `GHCR_TOKEN` env var)                                         |
| `--env, -e`    | Set an Actor default env var as `KEY=VALUE` (repeatable; empty values are dropped)   |
| `--env-file`   | Load Actor default env vars from a file (`KEY=VALUE` per line, `#` comments allowed) |

**Examples:**

```bash
cd my-actor

# Push (name comes from .actor/actor.json)
crawlee-cloud push --tag 1.0.0

# Build on a remote host over SSH
crawlee-cloud push --remote user@build-host --ssh-key ~/.ssh/id_ed25519

# Build and push the image to GitHub Container Registry
crawlee-cloud push --ghcr my-org/my-repo --ghcr-token <token>

# Inject default env vars into the Actor (repeatable -e, or a file)
crawlee-cloud push -e API_KEY=abc123 --env-file .env.production
```

---

### `run`

Run an Actor locally with local file storage.

```bash
crawlee-cloud run [options]
```

**Options:**

| Flag          | Description                     |
| ------------- | ------------------------------- |
| `--input, -i` | JSON input or path to JSON file |
| `--no-purge`  | Do not purge storage before run |

**Examples:**

```bash
# Run in current directory
cd my-actor
crawlee-cloud run

# Run with input
crawlee-cloud run --input '{"url": "https://example.com"}'

# Keep previous storage data
crawlee-cloud run --no-purge
```

Local storage is created in `./storage/` with datasets, key-value stores, and request queues.

---

### `logs`

Stream logs from a run.

```bash
crawlee-cloud logs <run-id> [options]
```

**Options:**

| Flag           | Description                                 |
| -------------- | ------------------------------------------- |
| `--follow, -f` | Continuously stream new logs                |
| `--limit, -l`  | Number of log lines to show (default: 1000) |

**Example:**

```bash
crawlee-cloud logs abc123 --follow
```

---

### `call`

Call a remote Actor on the platform and optionally wait for results.

```bash
crawlee-cloud call <actor> [options]
```

**Options:**

| Flag            | Description                                 |
| --------------- | ------------------------------------------- |
| `--input, -i`   | Input JSON or path to JSON file             |
| `--env, -e`     | Environment variable KEY=VALUE (repeatable) |
| `--wait, -w`    | Wait for run to finish                      |
| `--timeout, -t` | Timeout in seconds (default: 3600)          |
| `--memory, -m`  | Memory in MB (default: 1024)                |

**Examples:**

```bash
# Call an Actor
crawlee-cloud call my-scraper --input '{"url": "https://example.com"}'

# Call and wait for results
crawlee-cloud call my-scraper --wait --input '{"url": "https://example.com"}'

# Call with environment variables (use -e multiple times)
crc call my-actor -e KEY1=val1 -e KEY2=val2
```

> **Tip:** The `-e` flag can be repeated to pass multiple environment variables in a single call.

---

### `list`

List actors and recent runs on the platform. Alias: `ls`. Without flags, both actors and recent runs are shown.

```bash
crawlee-cloud list [options]
```

**Options:**

| Flag           | Description                     |
| -------------- | ------------------------------- |
| `--actors, -a` | List actors only                |
| `--runs, -r`   | List recent runs only           |
| `--limit, -n`  | Max items to show (default: 20) |
| `--json, -j`   | Output as JSON                  |

**Examples:**

```bash
# List actors and recent runs
crawlee-cloud list

# Recent runs only, as JSON
crc ls --runs --json
```

---

## Getting Your API Token

You need an API token to authenticate with Crawlee Cloud. There are two ways to get one:

### Via the Dashboard

1. Login to the dashboard at `http://localhost:3001`
2. Go to **Settings → API Keys**
3. Create a new API key

### Via the API

First, obtain a JWT token by logging in:

```bash
curl -X POST http://localhost:3000/v2/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@crawlee.cloud","password":"your-password"}'
```

Then create an API key using the JWT token:

```bash
curl -X POST http://localhost:3000/v2/auth/api-keys \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-key"}'
```

Use the resulting API key as your token when running `crawlee-cloud login`.

---

## Configuration

Configuration is stored in `~/.crawlee-cloud/config.json`:

```json
{
  "activeProfile": "default",
  "profiles": {
    "default": {
      "apiBaseUrl": "https://your-server.com",
      "token": "your-api-token"
    }
  }
}
```

If you have a legacy flat config file (just `{ apiBaseUrl, token }` at the top level), the CLI migrates it transparently into a `default` profile on first read.

### Environment Variables

| Variable                     | Description                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| `CRAWLEE_CLOUD_API_URL`      | Override the active profile's API base URL                         |
| `CRAWLEE_CLOUD_TOKEN`        | Override the active profile's API token                            |
| `CRAWLEE_CLOUD_PROFILE`      | Use this profile for the current invocation (overrides active)     |
| `CRAWLEE_CLOUD_REGISTRY_URL` | Docker registry URL used by `crc push` for image push, optional    |
| `GHCR_TOKEN`                 | GitHub Container Registry token used by the `crc push --ghcr` path |
| `GHCR_USER`                  | GHCR username for `crc push --ghcr` (default: `github`)            |
