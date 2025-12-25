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

### `login`

Authenticate with your Crawlee Cloud server.

```bash
crawlee-cloud login --url https://your-server.com
```

You'll be prompted to enter your API token. Credentials are stored in `~/.crawlee-cloud/config.json`.

---

### `push`

Build and push an Actor to the registry.

```bash
crawlee-cloud push [actor-name]
```

**Options:**

| Flag            | Description               |
| --------------- | ------------------------- |
| `--version, -v` | Version tag for the build |
| `--no-build`    | Skip local build step     |

**Example:**

```bash
cd my-actor
crawlee-cloud push my-scraper --version 1.0.0
```

---

### `run`

Execute an Actor on the server.

```bash
crawlee-cloud run <actor-name> [options]
```

**Options:**

| Flag           | Description              |
| -------------- | ------------------------ |
| `--input, -i`  | JSON input for the Actor |
| `--input-file` | Path to JSON input file  |
| `--wait, -w`   | Wait for completion      |
| `--timeout`    | Max wait time (seconds)  |

**Examples:**

```bash
# Run with inline input
crawlee-cloud run my-scraper --input '{"url": "https://example.com"}'

# Run with input file
crawlee-cloud run my-scraper --input-file ./input.json

# Run and wait for completion
crawlee-cloud run my-scraper --wait --timeout 300
```

---

### `logs`

Stream logs from a run.

```bash
crawlee-cloud logs <run-id> [options]
```

**Options:**

| Flag           | Description                  |
| -------------- | ---------------------------- |
| `--follow, -f` | Continuously stream new logs |
| `--tail, -n`   | Number of lines to show      |

**Example:**

```bash
crawlee-cloud logs abc123 --follow
```

---

### `call`

Make direct API requests.

```bash
crawlee-cloud call <method> <path> [options]
```

**Options:**

| Flag         | Description         |
| ------------ | ------------------- |
| `--data, -d` | Request body (JSON) |

**Examples:**

```bash
# List datasets
crawlee-cloud call GET /v2/datasets

# Create a dataset
crawlee-cloud call POST /v2/datasets --data '{"name": "my-data"}'
```

---

## Configuration

Configuration is stored in `~/.crawlee-cloud/config.json`:

```json
{
  "server": "https://your-server.com",
  "token": "your-api-token"
}
```

### Environment Variables

| Variable                | Description           |
| ----------------------- | --------------------- |
| `CRAWLEE_CLOUD_API_URL` | Override API base URL |
| `CRAWLEE_CLOUD_TOKEN`   | Override API token    |
