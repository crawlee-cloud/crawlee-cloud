/**
 * DigitalOcean runner provider — creates/destroys Droplets via the DO API.
 */

import type { RunnerProvider, RunnerConfig, RunnerInfo } from '../types.js';

const DO_API = 'https://api.digitalocean.com/v2';
const RUNNER_TAG = 'crawlee-runner';

export class DigitalOceanProvider implements RunnerProvider {
  readonly name = 'digitalocean';
  private token: string;

  constructor(config: Record<string, string>) {
    this.token = config.DO_TOKEN || config.DIGITALOCEAN_TOKEN || '';
    if (!this.token) {
      throw new Error('[Scaler/DO] Missing DO_TOKEN or DIGITALOCEAN_TOKEN');
    }
  }

  private async doRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${DO_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`[Scaler/DO] ${method} ${path}: ${res.status} ${err}`);
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  async createRunner(config: RunnerConfig): Promise<RunnerInfo> {
    const name = `crawlee-runner-${Date.now()}`;

    console.log(`[Scaler/DO] Creating Droplet ${name} (${config.size}) in ${config.region}`);

    const data = await this.doRequest<{ droplet: { id: number } }>('POST', '/droplets', {
      name,
      region: config.region,
      size: config.size,
      image: 'docker-20-04',
      ssh_keys: [config.sshKeyId],
      user_data: config.userData,
      tags: [RUNNER_TAG, ...config.tags],
      monitoring: true,
    });

    const dropletId = String(data.droplet.id);

    // Wait for Droplet to become active (poll every 5s, max 120s)
    let ip = '';
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const info = await this.doRequest<{
        droplet: { status: string; networks: { v4: { ip_address: string; type: string }[] } };
      }>('GET', `/droplets/${dropletId}`);

      if (info.droplet.status === 'active') {
        const publicNet = info.droplet.networks.v4.find((n) => n.type === 'public');
        if (publicNet) {
          ip = publicNet.ip_address;
          break;
        }
      }
    }

    if (!ip) {
      throw new Error(`[Scaler/DO] Droplet ${dropletId} did not become active within 120s`);
    }

    console.log(`[Scaler/DO] Droplet ${name} ready at ${ip}`);

    return {
      id: dropletId,
      ip,
      status: 'creating', // cloud-init still running
      createdAt: new Date(),
      activeRuns: 0,
    };
  }

  async destroyRunner(id: string): Promise<void> {
    console.log(`[Scaler/DO] Destroying Droplet ${id}`);
    await this.doRequest('DELETE', `/droplets/${id}`);
  }

  async listRunners(): Promise<RunnerInfo[]> {
    const data = await this.doRequest<{
      droplets: {
        id: number;
        name: string;
        status: string;
        created_at: string;
        networks: { v4: { ip_address: string; type: string }[] };
      }[];
    }>('GET', `/droplets?tag_name=${RUNNER_TAG}&per_page=100`);

    return data.droplets.map((d) => {
      const publicNet = d.networks.v4.find((n) => n.type === 'public');
      return {
        id: String(d.id),
        ip: publicNet?.ip_address || '',
        status: d.status === 'active' ? 'ready' : 'creating',
        createdAt: new Date(d.created_at),
        activeRuns: 0, // will be enriched by scaler from DB
      };
    });
  }
}
