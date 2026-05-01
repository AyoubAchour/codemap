#!/usr/bin/env node
/**
 * Stdio entry for the Codemap MCP server.
 *
 * After `npm install -g codemap-mcp` (or via `npx -y codemap-mcp`), configure
 * your MCP client. For Claude Code's mcp.json:
 * {
 *   "mcpServers": {
 *     "codemap": { "command": "codemap-mcp" }
 *   }
 * }
 *
 * For local development against this repo, point at the bundled JS:
 *   bun run build
 *   "command": "node", "args": ["/abs/path/to/codemap/dist/cli/codemap-mcp.js"]
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerTools } from "../src/index.js";

const server = new McpServer({
  name: "codemap",
  version: "0.1.0",
});

registerTools(server, { repoRoot: process.cwd() });

await server.connect(new StdioServerTransport());
