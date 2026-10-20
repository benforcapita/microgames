/** MCP-1: per-client install snippets for the Meshground MCP server on /me#mcp. */

export const MCP_TOKEN_PLACEHOLDER = 'YOUR_TOKEN';
export const MCP_PATH_PLACEHOLDER = '/ABSOLUTE/PATH/TO/meshground-mcp.mjs';

export const MCP_CLIENTS = [
  { id: 'claude-desktop', label: 'Claude Desktop', where: 'Settings → Developer → Edit Config (claude_desktop_config.json), then restart Claude.' },
  { id: 'claude-code', label: 'Claude Code', where: 'Run in your terminal.' },
  { id: 'cursor', label: 'Cursor', where: '~/.cursor/mcp.json (or .cursor/mcp.json in a project).' },
  { id: 'codex', label: 'Codex', where: '~/.codex/config.toml' },
  { id: 'gemini', label: 'Gemini CLI', where: '~/.gemini/settings.json' },
] as const;

export type McpClientId = (typeof MCP_CLIENTS)[number]['id'];

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function mcpSnippet(client: McpClientId, path: string, token: string): string {
  const file = path.trim() || MCP_PATH_PLACEHOLDER;
  const key = token.trim() || MCP_TOKEN_PLACEHOLDER;
  if (client === 'claude-code') {
    return `claude mcp add meshground --scope user --env MESHGROUND_TOKEN=${shellQuote(key)} -- node ${shellQuote(file)}`;
  }
  if (client === 'codex') {
    return `[mcp_servers.meshground]\ncommand = "node"\nargs = [${JSON.stringify(file)}]\nenv = { MESHGROUND_TOKEN = ${JSON.stringify(key)} }`;
  }
  const config = { mcpServers: { meshground: { command: 'node', args: [file], env: { MESHGROUND_TOKEN: key } } } };
  return JSON.stringify(config, null, 2);
}
