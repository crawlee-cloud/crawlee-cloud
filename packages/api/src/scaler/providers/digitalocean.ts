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

  private async doRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { allowStatuses?: number[] } = {}
  ): Promise<T> {
    const res = await fetch(`${DO_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      if (opts.allowStatuses?.includes(res.status)) {
        return {} as T;
      }
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

  // size slug → price_hourly, refreshed at most daily. DO reprices rarely;
  // the cache keeps scale-up bursts from hammering /v2/sizes.
  private sizePriceCache: { fetchedAt: number; prices: Map<string, number> } | null = null;

  async getHourlyPrice(size: string): Promise<number | null> {
    const DAY_MS = 24 * 60 * 60 * 1000;
    try {
      if (!this.sizePriceCache || Date.now() - this.sizePriceCache.fetchedAt > DAY_MS) {
        const data = await this.doRequest<{ sizes: { slug: string; price_hourly: number }[] }>(
          'GET',
          '/sizes?per_page=200'
        );
        this.sizePriceCache = {
          fetchedAt: Date.now(),
          prices: new Map(data.sizes.map((s) => [s.slug, s.price_hourly])),
        };
      }
      return this.sizePriceCache.prices.get(size) ?? null;
    } catch (err) {
      // Never let a pricing lookup block droplet creation — runs from this
      // droplet are stamped "price not recorded" instead.
      console.warn(`[Scaler/DO] Price lookup for ${size} failed:`, (err as Error).message);
      return null;
    }
  }

  async destroyRunner(id: string): Promise<void> {
    console.log(`[Scaler/DO] Destroying Droplet ${id}`);
    // Tolerate 404 — the Droplet may have been deleted out-of-band (manual
    // cleanup, account-level removal, or by a previous reap whose listing
    // hadn't yet caught up). Without this, the reaper would log the same
    // error every tick forever.
    await this.doRequest('DELETE', `/droplets/${id}`, undefined, { allowStatuses: [404] });
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
        name: d.name,
        ip: publicNet?.ip_address || '',
        status: d.status === 'active' ? 'ready' : 'creating',
        createdAt: new Date(d.created_at),
        activeRuns: 0, // will be enriched by scaler from DB
      };
    });
  }
}
