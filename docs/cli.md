# CLI Guide

The Crawlee Cloud CLI helps you manage Actors from the command line.

## Installation

```bash
npm install -g @crawlee-cloud/cli
```

## Commands

### Login

Authenticate with your Crawlee Cloud server:

```bash
crawlee-cloud login --server https://your-server.com
```

You'll be prompted for your API token.

### Push

Push an Actor to the registry:

```bash
crawlee-cloud push my-actor
```

This builds your Actor and uploads it to the server.

### Run

Execute an Actor:

```bash
crawlee-cloud run my-actor --input '{"url": "https://example.com"}'
```

Options:
- `--input` - JSON input for the Actor
- `--wait` - Wait for the run to complete
- `--timeout` - Maximum wait time in seconds

### Logs

Stream logs from a run:

```bash
crawlee-cloud logs <run-id>
```

Options:
- `--follow` - Keep streaming new logs
- `--tail` - Number of lines to show

### Call

Make direct API calls:

```bash
crawlee-cloud call GET /v2/datasets
crawlee-cloud call POST /v2/datasets --data '{"name": "my-dataset"}'
```

## Configuration

The CLI stores configuration in `~/.crawlee-cloud/config.json`:

```json
{
  "server": "https://your-server.com",
  "token": "your-api-token"
}
```

## Examples

```bash
# Login to server
crawlee-cloud login --server https://api.crawlee.cloud

# Push and run an Actor
crawlee-cloud push my-scraper
crawlee-cloud run my-scraper --input '{"startUrls": ["https://example.com"]}'

# Check run status
crawlee-cloud call GET /v2/actor-runs/<run-id>
```
