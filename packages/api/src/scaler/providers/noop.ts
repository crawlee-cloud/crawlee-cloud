/**
 * No-op runner provider — logs scaling decisions without taking action.
 * Used as default when no cloud provider is configured, or for testing.
 */

import type { RunnerProvider, RunnerConfig, RunnerInfo } from '../types.js';

export class NoopProvider implements RunnerProvider {
  readonly name = 'noop';

  async createRunner(config: RunnerConfig): Promise<RunnerInfo> {
    console.log(`[Scaler/noop] Would create runner in ${config.region} (${config.size})`);
    return {
      id: `noop-${Date.now()}`,
      ip: '0.0.0.0',
      status: 'ready',
      createdAt: new Date(),
      activeRuns: 0,
    };
  }

  async destroyRunner(id: string): Promise<void> {
    console.log(`[Scaler/noop] Would destroy runner ${id}`);
  }

  async listRunners(): Promise<RunnerInfo[]> {
    return [];
  }
}
