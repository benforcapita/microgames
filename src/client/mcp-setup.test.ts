import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MCP_CLIENTS, MCP_PATH_PLACEHOLDER, MCP_TOKEN_PLACEHOLDER, mcpSnippet } from './mcp-setup.ts';

describe('mcpSnippet', () => {
  it('writes valid mcpServers JSON for the JSON-config clients', () => {
    for (const id of ['claude-desktop', 'cursor', 'gemini'] as const) {
      const config = JSON.parse(mcpSnippet(id, 'C:\\Users\\me\\meshground-mcp.mjs', 'mgp_abc'));
      assert.deepEqual(config.mcpServers.meshground, {
        command: 'node',
        args: ['C:\\Users\\me\\meshground-mcp.mjs'],
        env: { MESHGROUND_TOKEN: 'mgp_abc' },
      });
    }
  });

  it('uses placeholders until a path and token are known', () => {
    for (const { id } of MCP_CLIENTS) {
      const s = mcpSnippet(id, '  ', '');
      assert.ok(s.includes(MCP_PATH_PLACEHOLDER) && s.includes(MCP_TOKEN_PLACEHOLDER), id);
    }
  });

  it('quotes shell and TOML values', () => {
    assert.equal(
      mcpSnippet('claude-code', "/Users/o'neil/mcp.mjs", 'mgp_x'),
      `claude mcp add meshground --scope user --env MESHGROUND_TOKEN='mgp_x' -- node '/Users/o'\\''neil/mcp.mjs'`,
    );
    assert.equal(
      mcpSnippet('codex', 'C:\\mcp.mjs', 'mgp_x'),
      '[mcp_servers.meshground]\ncommand = "node"\nargs = ["C:\\\\mcp.mjs"]\nenv = { MESHGROUND_TOKEN = "mgp_x" }',
    );
  });
});
