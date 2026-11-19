/**
 * Tests for the MCP client config shown in Settings.
 *
 * The block is pasted straight into an MCP client's config file, so it must
 * be valid as generated: the base URL the Apify MCP server expects has no
 * `/v2` suffix, `--tools` must always be present (the server's default set
 * includes Apify Store actors that do not exist on a self-hosted instance),
 * telemetry to Apify must be off, and a real token must never be embedded.
 */
import { describe, expect, it } from 'vitest';
import { buildMcpConfig, resolveApiBase } from '@/lib/mcp-config';

interface McpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const server = (json: string): McpServer =>
  (JSON.parse(json) as { mcpServers: Record<string, McpServer> }).mcpServers['crawlee-cloud'];

describe('buildMcpConfig', () => {
  it.each(['https://x.com', 'https://x.com/', 'https://x.com/v2', 'https://x.com/v2/'])(
    'normalises %s to the bare origin',
    (url) => {
      expect(server(buildMcpConfig({ apiBaseUrl: url })).env.APIFY_API_BASE_URL).toBe(
        'https://x.com'
      );
    }
  );

  it('keeps a path prefix that is not the /v2 suffix', () => {
    expect(
      server(buildMcpConfig({ apiBaseUrl: 'https://x.com/crawlee/v2' })).env.APIFY_API_BASE_URL
    ).toBe('https://x.com/crawlee');
  });

  it('pins the server version and disables telemetry', () => {
    const s = server(buildMcpConfig({ apiBaseUrl: 'https://x.com' }));
    expect(s.command).toBe('npx');
    expect(s.args.slice(0, 2)).toEqual(['-y', '@apify/actors-mcp-server@0.17.3']);
    expect(s.env.TELEMETRY_ENABLED).toBe('false');
  });

  it('never embeds a real token', () => {
    expect(server(buildMcpConfig({ apiBaseUrl: 'https://x.com' })).env.APIFY_TOKEN).toBe(
      '<your cp_ API key>'
    );
  });

  it('always passes --tools, adding username/actor entries when given', () => {
    const base = server(buildMcpConfig({ apiBaseUrl: 'https://x.com' })).args;
    expect(base.slice(2)).toEqual(['--tools', 'actors,runs,storage,get-actor-list']);
    const withActors = server(
      buildMcpConfig({ apiBaseUrl: 'https://x.com', username: 'alice', actors: ['a', 'b'] })
    ).args;
    expect(withActors[3]).toBe('actors,runs,storage,get-actor-list,alice/a,alice/b');
  });

  it('ignores actors when there is no username', () => {
    const args = server(buildMcpConfig({ apiBaseUrl: 'https://x.com', actors: ['a'] })).args;
    expect(args[3]).toBe('actors,runs,storage,get-actor-list');
  });

  it('is pretty-printed JSON with the documented key order', () => {
    const json = buildMcpConfig({ apiBaseUrl: 'https://x.com' });
    expect(json).toBe(JSON.stringify(JSON.parse(json), null, 2));
    expect(Object.keys(server(json))).toEqual(['command', 'args', 'env']);
    expect(Object.keys(server(json).env)).toEqual([
      'APIFY_API_BASE_URL',
      'APIFY_TOKEN',
      'TELEMETRY_ENABLED',
    ]);
  });
});

describe('resolveApiBase', () => {
  it('returns an absolute URL unchanged, with or without a document base', () => {
    expect(resolveApiBase('https://api.x.com')).toBe('https://api.x.com');
    expect(resolveApiBase('https://api.x.com', 'https://dash.x.com/settings')).toBe(
      'https://api.x.com'
    );
  });

  // Server render and the hydration pass have no document base, so they
  // must agree on the raw value; only the post-hydration render resolves it.
  it('returns a relative value unchanged until a document base is known', () => {
    expect(resolveApiBase('/api')).toBe('/api');
  });

  it('resolves a relative value against the document base, as fetch() does', () => {
    expect(resolveApiBase('/api', 'https://x.com/app/settings')).toBe('https://x.com/api');
    expect(resolveApiBase('api', 'https://x.com/app/settings')).toBe('https://x.com/app/api');
  });

  it('keeps the raw value when it cannot be resolved instead of throwing', () => {
    expect(resolveApiBase('//[bad', 'https://x.com/')).toBe('//[bad');
  });
});
