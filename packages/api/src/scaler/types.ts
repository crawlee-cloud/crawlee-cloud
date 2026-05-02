/**
 * Runner auto-scaler types.
 *
 * Platform-agnostic interface — implement RunnerProvider for any cloud.
 */

export interface RunnerInfo {
  /** Provider-specific ID (e.g. Droplet ID) */
  id: string;
  /**
   * Provider-specific name (e.g. Droplet name, container name). Used as a
   * fallback when matching heartbeats: cloud-init can't always set
   * RUNNER_ID to the provider id at boot, so the runner falls back to
   * os.hostname() — which providers typically set to this name. The
   * scaler tries id, ip, then name when looking up a runner's heartbeat.
   */
  name?: string;
  /** IP address for SSH access */
  ip: string;
  /**
   * Current state:
   *   - creating:   provider returned, runner is booting / starting up
   *   - ready:      heartbeat present, no active runs
   *   - busy:       heartbeat present, has active runs
   *   - draining:   heartbeat present but resource-pressured (high CPU/mem)
   *                 — alive, may recover, NOT eligible for reaping
   *   - dead:       no heartbeat for >3 minutes — presumed gone, eligible
   *                 for reaping every tick (independent of demand-based
   *                 scale-down)
   *   - destroying: scaler has issued destroyRunner; provider is tearing it down
   */
  status: 'creating' | 'ready' | 'busy' | 'draining' | 'dead' | 'destroying';
  /** When this runner was created */
  createdAt: Date;
  /** Number of runs currently executing */
  activeRuns: number;
}

export interface RunnerConfig {
  /** Region/location to create the runner in */
  region: string;
  /** Machine size (provider-specific slug) */
  size: string;
  /** SSH key ID or fingerprint to inject */
  sshKeyId: string;
  /** User-data / cloud-init script to run on boot */
  userData: string;
  /** Tags/labels for identification */
  tags: string[];
  /**
   * MAX_CONCURRENT_RUNS to inject into the runner. Sourced from
   * loadScalerConfig().runsPerRunner — single source of truth. Providers
   * MUST use this value rather than re-reading SCALER_RUNS_PER_RUNNER from
   * their own env: the loader already applies the documented fallback (5),
   * and divergent fallbacks would have the dashboard report one value
   * while runners actually used another.
   */
  runsPerRunner: number;
}

export interface ScalerConfig {
  /** Enable/disable the auto-scaler */
  enabled: boolean;
  /** Provider name */
  provider: 'digitalocean' | 'noop' | 'local-docker';
  /** Min runners to keep alive (0 = scale to zero) */
  minRunners: number;
  /** Max runners to create */
  maxRunners: number;
  /** Scale up when READY runs exceed this threshold */
  scaleUpThreshold: number;
  /** Scale down after runner is idle for this many seconds */
  idleTimeoutSecs: number;
  /** How often to check queue (seconds) */
  pollIntervalSecs: number;
  /** Max concurrent runs per runner */
  runsPerRunner: number;
  /** Runner machine size */
  runnerSize: string;
  /** Runner region */
  runnerRegion: string;
  /** SSH key ID for runners */
  sshKeyId: string;
  /** Provider-specific config */
  providerConfig: Record<string, string>;
}

/**
 * Interface for cloud provider implementations.
 * Implement this to add support for a new cloud platform.
 */
export interface RunnerProvider {
  /** Provider name for logging */
  readonly name: string;

  /** Create a new runner VM. Returns when the VM is booted (not necessarily ready to process). */
  createRunner(config: RunnerConfig): Promise<RunnerInfo>;

  /** Destroy a runner VM. Should wait for the VM to be fully deleted. */
  destroyRunner(id: string): Promise<void>;

  /** List all runner VMs managed by this provider. */
  listRunners(): Promise<RunnerInfo[]>;
}
