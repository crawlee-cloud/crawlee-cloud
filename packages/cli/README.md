# Crawlee Cloud CLI

The official CLI tool for [Crawlee Cloud](https://crawlee.cloud).

Manage your Crawlee Cloud resources, deploy Actors, and view logs directly from your terminal.

## Installation

```bash
npm install -g @crawlee-cloud/cli
```

Or use directly with npx:

```bash
npx @crawlee-cloud/cli <command>
```

## Usage

```bash
crawlee-cloud <command> [options]
# Alias
crc <command> [options]
```

### Commands

- `login` - Login to your Crawlee Cloud account (supports `--profile` for multi-environment setups)
- `info` - Show the active profile, API URL, server status, and authenticated user
- `profile` - Manage saved login profiles (`list`, `use`, `rm`)
- `init` - Scaffold a new Actor project from an Apify template
- `push` - Deploy an Actor to the cloud
- `run` - Run an Actor locally
- `call` - Run an Actor on the platform (with optional `--wait`)
- `list` - List actors and runs
- `logs` - Stream logs from a running Actor
- `status` - Check the status of a run
- `dev` - Run an Actor locally with hot reload

## Example

```bash
# Login
crc login

# Push the current directory as an Actor
crc push my-actor

# Run the Actor
crc call my-actor
```

## Configuration

Connect to your self-hosted Crawlee Cloud server:

```bash
# Login to your server
crc login --url https://your-server.com
```

You'll be prompted for your API token. Credentials are stored in `~/.crawlee-cloud/config.json`.

### Profiles (multi-environment)

Switch between local, staging, and production with named profiles. Each profile holds its own API URL + token.

```bash
# Save credentials under a named profile
crc login --profile local   --url http://localhost:3000     --token <T>
crc login --profile staging --url https://crc.staging.com   --token <T>
crc login --profile prod    --url https://crc.prod.com      --token <T>

# List all profiles (active marked with *)
crc profile list

# Switch the active profile
crc profile use staging

# Remove a profile
crc profile rm staging

# Check what's currently active and reachable
crc info
crc info --json   # for scripts / CI healthchecks
```

For per-invocation overrides without changing the active profile, use the `CRAWLEE_CLOUD_PROFILE` env var:

```bash
CRAWLEE_CLOUD_PROFILE=prod crc push    # one-off push to prod, no `profile use` needed
```

`crc info` exits non-zero if the server is unreachable or the token is invalid, which makes it suitable as a CI gate before `crc push`:

```bash
crc info --json >/dev/null && crc push
```

### Environment Variables

| Variable                     | Description                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| `CRAWLEE_CLOUD_API_URL`      | Override the active profile's API base URL                      |
| `CRAWLEE_CLOUD_TOKEN`        | Override the active profile's API token                         |
| `CRAWLEE_CLOUD_PROFILE`      | Override the active profile name for this invocation            |
| `CRAWLEE_CLOUD_REGISTRY_URL` | Docker registry URL used by `crc push` for image push, optional |

## Documentation

For full documentation, visit the [Crawlee Cloud Documentation](https://github.com/crawlee-cloud/crawlee-cloud).
