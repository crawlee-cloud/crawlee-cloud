/**
 * Tests for the webhook SSRF guard (isPrivateUrl) and the runner's
 * self-referential API URL normalization (selfApiBaseUrl) in queue.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isPrivateUrl } from '../src/queue.js';

describe('isPrivateUrl', () => {
  it('blocks loopback addresses', () => {
    expect(isPrivateUrl('http://localhost:3000/hook')).toBe(true);
    expect(isPrivateUrl('http://127.0.0.1/hook')).toBe(true);
    expect(isPrivateUrl('http://[::1]:8080/hook')).toBe(true);
  });

  it('blocks the whole 127.0.0.0/8 loopback range, not just 127.0.0.1', () => {
    expect(isPrivateUrl('http://127.0.0.2/hook')).toBe(true);
    expect(isPrivateUrl('http://127.1.2.3/hook')).toBe(true);
  });

  it('blocks link-local / cloud metadata addresses', () => {
    expect(isPrivateUrl('http://169.254.169.254/latest/meta-data')).toBe(true);
    expect(isPrivateUrl('http://169.254.0.1/')).toBe(true);
  });

  it('blocks RFC 1918 private ranges', () => {
    expect(isPrivateUrl('http://10.0.0.5/')).toBe(true);
    expect(isPrivateUrl('http://10.255.255.255/')).toBe(true);
    expect(isPrivateUrl('http://172.16.0.1/')).toBe(true);
    expect(isPrivateUrl('http://172.31.9.9/')).toBe(true);
    expect(isPrivateUrl('http://192.168.1.1/')).toBe(true);
    expect(isPrivateUrl('http://0.0.0.0/')).toBe(true);
  });

  it('allows the 172.x addresses outside the /12 private block', () => {
    expect(isPrivateUrl('http://172.15.0.1/')).toBe(false);
    expect(isPrivateUrl('http://172.32.0.1/')).toBe(false);
  });

  it('allows public IPs and hostnames', () => {
    expect(isPrivateUrl('https://example.com/webhook')).toBe(false);
    expect(isPrivateUrl('https://hooks.example.io:8443/x?y=1')).toBe(false);
    expect(isPrivateUrl('http://8.8.8.8/')).toBe(false);
  });

  it('blocks unparseable URLs', () => {
    expect(isPrivateUrl('not a url')).toBe(true);
    expect(isPrivateUrl('')).toBe(true);
  });
});

describe('selfApiBaseUrl', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  async function selfUrlWith(apiBaseUrl: string): Promise<string> {
    process.env.API_BASE_URL = apiBaseUrl;
    const { selfApiBaseUrl } = await import('../src/queue.js');
    return selfApiBaseUrl();
  }

  it('collapses host.docker.internal back to localhost for the host-side runner', async () => {
    expect(await selfUrlWith('http://host.docker.internal:3000')).toBe('http://localhost:3000');
  });

  it('leaves ordinary deploy URLs untouched', async () => {
    expect(await selfUrlWith('https://api.example.com')).toBe('https://api.example.com');
  });

  it('does not rewrite host.docker.internal appearing mid-path', async () => {
    expect(await selfUrlWith('https://proxy.example.com/host.docker.internal')).toBe(
      'https://proxy.example.com/host.docker.internal'
    );
  });
});
