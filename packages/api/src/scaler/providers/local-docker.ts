/**
 * Local Docker runner provider — emulates a cloud VM provider by spawning
 * runner *containers* on the host's Docker daemon. Used for end-to-end
 * scaling tests without paying for real cloud VMs.
 *
 * Differences from DigitalOcean provider:
 *   - No SSH key, region, or size — those fields on RunnerConfig are ignored.
 *   - No cloud-init: the runner image is expected to already exist locally
 *     (build with `docker build -t crawlee-cloud-runner:local packages/runner`).
 *   - "IP" is not a real IP — we reuse the runnerId so the scaler's heartbeat
 *     lookup at scaler/index.ts:169 (`heartbeats.get(runner.ip)`) succeeds.
 *
 * Selected when SCALER_PROVIDER=local-docker.
 */

import Docker from 'dockerode';
import { nanoid } from 'nanoid';
import type { RunnerProvider, RunnerConfig, RunnerInfo } from '../types.js';

/** Label applied to every container we create, so listRunners() can find them. */
const RUNNER_LABEL = 'crawlee-cloud.scaler-runner';

export class LocalDockerProvider implements RunnerProvider {
  readonly name = 'local-docker';

  private docker = new Docker({
    socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  });

  /** Cache the resolved network so we only probe Docker once per process. */
  private resolvedNetwork: string | null = null;

  /**
   * Pick the Docker network to attach runner containers to.
   *
   * Priority:
   *   1. `DOCKER_NETWORK` env var (explicit override)
   *   2. The single compose-managed network on the host (auto-detected via
   *      `com.docker.compose.project` label)
   *
   * Throws a clear, actionable error otherwise — there is no safe default
   * (Docker's `bridge` network can't resolve `postgres`/`redis` service
   * names), and silently picking the wrong one gives an opaque
   * "connection refused" several seconds later inside the runner.
   */
  private async resolveNetwork(): Promise<string> {
    if (this.resolvedNetwork) return this.resolvedNetwork;

    if (process.env.DOCKER_NETWORK) {
      this.resolvedNetwork = process.env.DOCKER_NETWORK;
      return this.resolvedNetwork;
    }

    type NetworkSummary = { Name: string; Labels?: Record<string, string> | null };
    const networks = (await this.docker.listNetworks()) as NetworkSummary[];
    const composeNets = networks.filter((n) => n.Labels?.['com.docker.compose.project']);

    const [only] = composeNets;
    if (composeNets.length === 1 && only) {
      this.resolvedNetwork = only.Name;
      console.log(`[Scaler/local-docker] Auto-detected network: ${this.resolvedNetwork}`);
      return this.resolvedNetwork;
    }

    const available = composeNets.map((n) => n.Name).join(', ') || '(none found)';
    throw new Error(
      `[Scaler/local-docker] Cannot determine Docker network. ` +
        `Set DOCKER_NETWORK explicitly to one of: ${available}. ` +
        `(Run \`docker network ls\` and pick the one your postgres/redis services are attached to.)`
    );
  }

  async createRunner(config: RunnerConfig): Promise<RunnerInfo> {
    const runnerId = `local-${nanoid(8)}`;
    const image = process.env.LOCAL_RUNNER_IMAGE || 'crawlee-cloud-runner:local';
    const network = await this.resolveNetwork();

    // Env vars the runner container needs to come up and heartbeat into Redis.
    // `RUNNER_ID` MUST equal `runnerId` below — that is what links the
    // RunnerInfo we return here with the heartbeat that will appear in Redis.
    //
    // Important: DATABASE_URL/REDIS_URL deliberately do NOT inherit from the
    // host API's process.env, because that points at `localhost:*` which is
    // unreachable from inside the container. We default to compose service
    // names instead, with explicit overrides for non-default setups.
    const env: Record<string, string> = {
      RUNNER_ID: runnerId,
      // API runs on the host; postgres/redis run inside the compose stack.
      // host.docker.internal works on Mac/Windows; on Linux pass
      // `--add-host=host.docker.internal:host-gateway` or set
      // LOCAL_RUNNER_API_BASE_URL to your host IP.
      API_BASE_URL: process.env.LOCAL_RUNNER_API_BASE_URL || 'http://host.docker.internal:3000',
      DATABASE_URL:
        process.env.LOCAL_RUNNER_DATABASE_URL ||
        'postgresql://postgres:postgres@postgres:5432/crawlee_cloud',
      REDIS_URL: process.env.LOCAL_RUNNER_REDIS_URL || 'redis://redis:6379',
      API_TOKEN: process.env.LOCAL_RUNNER_API_TOKEN || 'runner-token',
      DOCKER_SOCKET: '/var/run/docker.sock',
      DOCKER_NETWORK: network,
      // Sourced from loadScalerConfig().runsPerRunner (default 5) so this
      // matches what the dashboard's /v2/system/info reports — the parallel
      // process.env.SCALER_RUNS_PER_RUNNER read this used to do had a
      // different fallback (2) and could disagree with the loader.
      MAX_CONCURRENT_RUNS: String(config.runsPerRunner),
      LOG_LEVEL: 'info',
    };

    const envArray = Object.entries(env).map(([k, v]) => `${k}=${v}`);

    const container = await this.docker.createContainer({
      name: runnerId,
      Image: image,
      Env: envArray,
      Labels: {
        [RUNNER_LABEL]: 'true',
        'crawlee-cloud.runner-id': runnerId,
      },
      HostConfig: {
        NetworkMode: network,
        Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
        AutoRemove: false, // keep stopped containers around so we can `docker logs` them
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      },
    });
    await container.start();

    return {
      id: runnerId,
      ip: runnerId, // the scaler matches heartbeats by id OR ip; both work
      status: 'creating', // the heartbeat will flip this to 'ready'/'busy'
      createdAt: new Date(),
      activeRuns: 0,
    };
  }

  async destroyRunner(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    try {
      await container.stop({ t: 10 }); // 10s grace period for in-flight runs
    } catch (err) {
      // Already stopped is fine; anything else we'll surface via remove().
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 304 && code !== 404) throw err;
    }
    try {
      await container.remove({ force: true });
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 404) throw err; // 404 = already gone, fine
    }
  }

  async listRunners(): Promise<RunnerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true, // include stopped — scaler will mark them 'draining' via missing heartbeat
      filters: { label: [`${RUNNER_LABEL}=true`] },
    });

    return containers.map((c) => {
      const runnerId = c.Labels['crawlee-cloud.runner-id'] || c.Id;
      // Docker prefixes names with '/', e.g. '/crawlee-runner-abc'. Strip it
      // so the value matches what `os.hostname()` returns inside the container.
      const containerName = (c.Names?.[0] || '').replace(/^\//, '') || undefined;
      return {
        id: runnerId,
        name: containerName,
        ip: runnerId,
        status: c.State === 'running' ? 'ready' : 'draining',
        createdAt: new Date(c.Created * 1000),
        activeRuns: 0, // enriched by the scaler from heartbeats
      };
    });
  }
}
