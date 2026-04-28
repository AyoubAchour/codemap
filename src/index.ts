import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerGetNode } from "./tools/get_node.js";
import { registerLink } from "./tools/link.js";
import { registerQueryGraph } from "./tools/query_graph.js";
import { registerSetActiveTopic } from "./tools/set_active_topic.js";

export interface RegisterToolsOptions {
  /** Path to the repo root; `<repoRoot>/.codemap/graph.json` is the store. */
  repoRoot: string;
}

/**
 * Register the four "simple" Codemap MCP tools onto the given server.
 * `emit_node` lands separately in task-014 (depends on collision detection
 * + per-turn cap).
 *
 * Tools registered:
 *  - query_graph
 *  - get_node
 *  - link
 *  - set_active_topic
 */
export function registerTools(
  server: McpServer,
  options: RegisterToolsOptions,
): void {
  registerQueryGraph(server, options);
  registerGetNode(server, options);
  registerLink(server, options);
  registerSetActiveTopic(server, options);
}
