/**
 * Tests for cleanupDocker's disk-pressure image eviction (docker.ts).
 *
 * Background (prod 2026-08-04/05): the periodic cleanup only pruned
 * DANGLING images — but fleet disk growth comes from new distinct actor
 * tags (one `:latest` per scraper, 2.5-8.4GB each with bundled
 * browsers), which dangling-prune never touches. 22 tags filled both
 * 80GB runner disks to 100% while cleanup ran faithfully every 30
 * minutes. Under disk pressure the cleanup must also evict unused
 * images — but ONLY tags under the configured IMAGE_REGISTRY prefix,
 * the sole images with a proven re-pull path: a blanket prune would
 * permanently destroy locally built images (default no-registry
 * deployment, custom default_run_options.image values) and innocent
 * bystanders on shared Docker hosts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Docker from 'dockerode';
import { config } from '../src/config.js';
import { cleanupDocker } from '../src/docker.js';

interface FakeImage {
  Id: string;
  RepoTags?: string[];
  Size?: number;
}

function fakeDocker(images: FakeImage[] = []) {
  const removeCalls: string[] = [];
  const docker = {
    listContainers: vi.fn().mockResolvedValue([]),
    pruneImages: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
    pruneBuilder: vi.fn().mockResolvedValue(undefined),
    listImages: vi.fn().mockResolvedValue(images),
    getImage: vi.fn((tag: string) => ({
      remove: vi.fn(() => {
        removeCalls.push(tag);
        return Promise.resolve();
      }),
    })),
  } as unknown as Docker & {
    listContainers: ReturnType<typeof vi.fn>;
    pruneImages: ReturnType<typeof vi.fn>;
    pruneBuilder: ReturnType<typeof vi.fn>;
    listImages: ReturnType<typeof vi.fn>;
    getImage: ReturnType<typeof vi.fn>;
  };
  return { docker, removeCalls };
}

// Eviction is registry-scoped: only tags under the configured
// IMAGE_REGISTRY prefix are provably re-pullable. config is a plain
// module singleton — mutate and restore.
const originalRegistry = config.imageRegistry;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  config.imageRegistry = 'ghcr.io/test-org';
});

afterEach(() => {
  config.imageRegistry = originalRegistry;
  vi.restoreAllMocks();
});

describe('cleanupDocker disk-pressure eviction', () => {
  it('evicts only registry-prefixed tags once disk usage crosses the eviction threshold', async () => {
    const { docker, removeCalls } = fakeDocker([
      { Id: 'sha256:a', RepoTags: ['ghcr.io/test-org/actor-shop:latest'], Size: 3_000_000_000 },
      // Locally built (default deployment convention) — must survive.
      { Id: 'sha256:b', RepoTags: ['crawlee-cloud/actor-local:latest'], Size: 2_000_000_000 },
      // Foreign image on a shared host — must survive.
      { Id: 'sha256:c', RepoTags: ['postgres:16'], Size: 500_000_000 },
      // Untagged (dangling) — handled by the dangling prune, not eviction.
      { Id: 'sha256:d', RepoTags: [] },
    ]);

    await cleanupDocker({ dockerClient: docker, getDiskUsageRatio: () => 0.9 });

    expect(removeCalls).toEqual(['ghcr.io/test-org/actor-shop:latest']);
    // The blanket "all unused images" prune (dangling=false) must never
    // be issued — it has no per-image re-pull guarantee.
    const allUnusedPrune = docker.pruneImages.mock.calls.find(
      (c) =>
        (c[0] as { filters?: { dangling?: Record<string, boolean> } })?.filters?.dangling?.false
    );
    expect(allUnusedPrune).toBeUndefined();
  });

  // The default deployment builds actor images locally (`crc push` with
  // no IMAGE_REGISTRY) — there is no re-pull path, so evicting them is
  // permanent: every idle actor's next run would 404 against Docker Hub
  // until manually re-pushed. Eviction must stay off without a registry.
  it('never evicts when no image registry is configured', async () => {
    config.imageRegistry = '';
    const { docker, removeCalls } = fakeDocker([
      { Id: 'sha256:b', RepoTags: ['crawlee-cloud/actor-local:latest'], Size: 2_000_000_000 },
    ]);

    await cleanupDocker({ dockerClient: docker, getDiskUsageRatio: () => 0.99 });

    expect(removeCalls).toEqual([]);
    expect(docker.listImages).not.toHaveBeenCalled();
    // The safe cleanups still run.
    const danglingPrune = docker.pruneImages.mock.calls.find(
      (c) => (c[0] as { filters?: { dangling?: Record<string, boolean> } })?.filters?.dangling?.true
    );
    expect(danglingPrune).toBeDefined();
  });

  it('leaves images alone under normal disk usage', async () => {
    const { docker, removeCalls } = fakeDocker([
      { Id: 'sha256:a', RepoTags: ['ghcr.io/test-org/actor-shop:latest'], Size: 3_000_000_000 },
    ]);

    await cleanupDocker({ dockerClient: docker, getDiskUsageRatio: () => 0.5 });

    expect(removeCalls).toEqual([]);
    expect(docker.listImages).not.toHaveBeenCalled();
    // The pre-existing dangling prune must still run.
    const danglingPrune = docker.pruneImages.mock.calls.find(
      (c) => (c[0] as { filters?: { dangling?: Record<string, boolean> } })?.filters?.dangling?.true
    );
    expect(danglingPrune).toBeDefined();
  });

  // Non-forced remove: the daemon refuses images referenced by a
  // container (409). One refused image must not abort the sweep.
  it('skips in-use images and continues evicting the rest', async () => {
    const { docker, removeCalls } = fakeDocker([
      { Id: 'sha256:a', RepoTags: ['ghcr.io/test-org/actor-busy:latest'], Size: 1_000_000_000 },
      { Id: 'sha256:b', RepoTags: ['ghcr.io/test-org/actor-idle:latest'], Size: 1_000_000_000 },
    ]);
    docker.getImage.mockImplementation((tag: string) => ({
      remove: vi.fn(() => {
        if (tag.includes('busy')) {
          return Promise.reject(new Error('(HTTP code 409) conflict - image is being used'));
        }
        removeCalls.push(tag);
        return Promise.resolve();
      }),
    }));

    await cleanupDocker({ dockerClient: docker, getDiskUsageRatio: () => 0.9 });

    expect(removeCalls).toEqual(['ghcr.io/test-org/actor-idle:latest']);
  });
});
