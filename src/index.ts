import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerEmitNode } from "./tools/emit_node.js";
import { registerGetNode } from "./tools/get_node.js";
import { registerLink } from "./tools/link.js";
import { registerQueryGraph } from "./tools/query_graph.js";
import { registerSetActiveTopic } from "./tools/set_active_topic.js";

export interface RegisterToolsOptions {
  /** Path to the repo root; `<repoRoot>/.codemap/graph.json` is the store. */
  repoRoot: string;
}

/**
 * Register all 5 Codemap MCP tools onto the given server, per V1_SPEC §7.
 *
 *  - query_graph
 *  - get_node
 *  - emit_node       (collision-aware; per-turn cap)
 *  - link
 *  - set_active_topic
 */
export function registerTools(
  server: McpServer,
  options: RegisterToolsOptions,
): void {
  registerQueryGraph(server, options);
  registerGetNode(server, options);
  registerEmitNode(server, options);
  registerLink(server, options);
  registerSetActiveTopic(server, options);
}
