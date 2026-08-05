/**
 * Tests for cleanupDocker's disk-pressure image eviction (docker.ts).
 *
 * Background (prod 2026-08-04/05): the periodic cleanup only pruned
 * DANGLING images — but fleet disk growth comes from new distinct actor
 * tags (one `:latest` per scraper, 2.5-8.4GB each with bundled
 * browsers), which dangling-prune never touches. 22 tags filled both
 * 80GB runner disks to 100% while cleanup ran faithfully every 30
 * minutes. Under disk pressure the cleanup must also evict UNUSED
 * TAGGED images (in-use ones are protected by the daemon); the cost is
 * a re-pull on next claim, the alternative is a fleet-wide pull-failure
 * storm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Docker from 'dockerode';
import { config } from '../src/config.js';
import { cleanupDocker } from '../src/docker.js';

function fakeDocker() {
  return {
    listContainers: vi.fn().mockResolvedValue([]),
    pruneImages: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
    pruneBuilder: vi.fn().mockResolvedValue(undefined),
  } as unknown as Docker & {
    listContainers: ReturnType<typeof vi.fn>;
    pruneImages: ReturnType<typeof vi.fn>;
    pruneBuilder: ReturnType<typeof vi.fn>;
  };
}

// Eviction is registry-gated: "re-pull on next claim" only holds for
// registry-backed images, so tests that exercise eviction must configure
// one. config is a plain module singleton — mutate and restore.
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
  it('evicts unused tagged images once disk usage crosses the eviction threshold', async () => {
    const docker = fakeDocker();

    await cleanupDocker({ dockerClient: docker, getDiskUsageRatio: () => 0.9 });

    // dangling=false is the Docker API's "all unused images" prune (-a).
    const allUnusedPrune = docker.pruneImages.mock.calls.find(
      (c) =>
        (c[0] as { filters?: { dangling?: Record<string, boolean> } })?.filters?.dangling?.false
    );
    expect(allUnusedPrune).toBeDefined();
  });

  // The default deployment builds actor images locally (`crc push` with
  // no IMAGE_REGISTRY) — there is no re-pull path, so evicting them is
  // permanent: every idle actor's next run would 404 against Docker Hub
  // until manually re-pushed. Eviction must stay off without a registry.
  it('never evicts tagged images when no image registry is configured', async () => {
    config.imageRegistry = '';
    const docker = fakeDocker();

    await cleanupDocker({ dockerClient: docker, getDiskUsageRatio: () => 0.99 });

    const allUnusedPrune = docker.pruneImages.mock.calls.find(
      (c) =>
        (c[0] as { filters?: { dangling?: Record<string, boolean> } })?.filters?.dangling?.false
    );
    expect(allUnusedPrune).toBeUndefined();
    // The safe cleanups still run.
    const danglingPrune = docker.pruneImages.mock.calls.find(
      (c) => (c[0] as { filters?: { dangling?: Record<string, boolean> } })?.filters?.dangling?.true
    );
    expect(danglingPrune).toBeDefined();
  });

  it('leaves tagged images alone under normal disk usage', async () => {
    const docker = fakeDocker();

    await cleanupDocker({ dockerClient: docker, getDiskUsageRatio: () => 0.5 });

    const allUnusedPrune = docker.pruneImages.mock.calls.find(
      (c) =>
        (c[0] as { filters?: { dangling?: Record<string, boolean> } })?.filters?.dangling?.false
    );
    expect(allUnusedPrune).toBeUndefined();
    // The pre-existing dangling prune must still run.
    const danglingPrune = docker.pruneImages.mock.calls.find(
      (c) => (c[0] as { filters?: { dangling?: Record<string, boolean> } })?.filters?.dangling?.true
    );
    expect(danglingPrune).toBeDefined();
  });
});
