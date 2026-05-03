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

import packageJson from "../package.json" with { type: "json" };
import { registerTools } from "../src/index.js";
import { SERVER_INSTRUCTIONS } from "../src/instructions.js";

// `instructions` reaches the agent at `initialize` time and is the standard
// place to put cross-tool lifecycle policy that individual tool descriptions
// can't carry. See src/instructions.ts for the wording + the M3a finding
// that motivated adding it in v0.1.1.
const server = new McpServer(
  {
    name: "codemap",
    version: packageJson.version,
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

registerTools(server, { repoRoot: process.cwd() });

await server.connect(new StdioServerTransport());
