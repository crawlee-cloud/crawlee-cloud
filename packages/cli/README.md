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

- `login` - Login to your Crawlee Cloud account
- `push` - Deploy an Actor to the cloud
- `run` - Start an Actor run
- `call` - Run an Actor and wait for it to finish
- `logs` - Stream logs from a running Actor

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

### Environment Variables

| Variable                | Description           |
| ----------------------- | --------------------- |
| `CRAWLEE_CLOUD_API_URL` | Override API base URL |
| `CRAWLEE_CLOUD_TOKEN`   | Override API token    |

## Documentation

For full documentation, visit the [Crawlee Cloud Documentation](https://github.com/crawlee-cloud/crawlee-cloud).
