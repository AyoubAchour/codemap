#!/usr/bin/env node
/**
 * Stdio entry for the Codemap MCP server.
 *
 * Configure in your MCP client (e.g. Claude Code's mcp.json):
 * {
 *   "mcpServers": {
 *     "codemap": {
 *       "command": "bun",
 *       "args": ["run", "/abs/path/to/codemap/bin/codemap-mcp.ts"]
 *     }
 *   }
 * }
 *
 * Or after `bun build --compile bin/codemap-mcp.ts --outfile dist/codemap-mcp`,
 * point `command` directly at the produced binary.
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
