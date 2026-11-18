/**
 * Builds the MCP client config block shown in Settings.
 *
 * Crawlee Cloud has no MCP server of its own: agents run the stock Apify MCP
 * server (stdio) pointed at this instance. The shape mirrors the Claude
 * Desktop snippet in docs/mcp.md so the two never disagree.
 */

/** The version docs/mcp.md documents and tests/mcp-e2e checks against. */
export const MCP_SERVER_PACKAGE = '@apify/actors-mcp-server@0.17.3';

/**
 * Always passed explicitly: the server's default set (`actors,docs`) also
 * loads two Apify Store actors that do not exist on a self-hosted instance.
 */
const BASE_TOOLS = ['actors', 'runs', 'storage', 'get-actor-list'];

/** Shown instead of a key: the block is meant to be copied and shared. */
export const MCP_TOKEN_PLACEHOLDER = '<your cp_ API key>';

/** The Apify MCP server wants the origin without the `/v2` API prefix. */
function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v2$/, '').replace(/\/+$/, '');
}

export function buildMcpConfig(opts: {
  apiBaseUrl: string;
  username?: string;
  actors?: string[];
}): string {
  const { apiBaseUrl, username, actors = [] } = opts;
  const tools = [...BASE_TOOLS, ...(username ? actors.map((name) => `${username}/${name}`) : [])];

  return JSON.stringify(
    {
      mcpServers: {
        'crawlee-cloud': {
          command: 'npx',
          args: ['-y', MCP_SERVER_PACKAGE, '--tools', tools.join(',')],
          env: {
            APIFY_API_BASE_URL: normaliseBaseUrl(apiBaseUrl),
            APIFY_TOKEN: MCP_TOKEN_PLACEHOLDER,
            TELEMETRY_ENABLED: 'false',
          },
        },
      },
    },
    null,
    2
  );
}
