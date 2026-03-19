/**
 * Runner auto-scaler types.
 *
 * Platform-agnostic interface — implement RunnerProvider for any cloud.
 */

export interface RunnerInfo {
  /** Provider-specific ID (e.g. Droplet ID) */
  id: string;
  /** IP address for SSH access */
  ip: string;
  /** Current state */
  status: 'creating' | 'ready' | 'busy' | 'draining' | 'destroying';
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
}

export interface ScalerConfig {
  /** Enable/disable the auto-scaler */
  enabled: boolean;
  /** Provider name */
  provider: 'digitalocean' | 'noop';
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
