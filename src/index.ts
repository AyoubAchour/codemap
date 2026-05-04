import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerClearIndex } from "./tools/clear_index.js";
import { registerEmitNode } from "./tools/emit_node.js";
import { registerGetIndexStatus } from "./tools/get_index_status.js";
import { registerGetNode } from "./tools/get_node.js";
import { registerIndexCodebase } from "./tools/index_codebase.js";
import { registerLink } from "./tools/link.js";
import { registerQueryContext } from "./tools/query_context.js";
import { registerQueryGraph } from "./tools/query_graph.js";
import { registerSearchSource } from "./tools/search_source.js";
import { registerSetActiveTopic } from "./tools/set_active_topic.js";

export interface RegisterToolsOptions {
  /** Path to the repo root; `<repoRoot>/.codemap/graph.json` is the store. */
  repoRoot: string;
}

/**
 * Register Codemap's MCP tools onto the given server.
 *
 * Source discovery:
 *  - index_codebase
 *  - query_context
 *  - search_source
 *  - get_index_status
 *  - clear_index
 *
 * Curated memory graph:
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
  registerIndexCodebase(server, options);
  registerQueryContext(server, options);
  registerSearchSource(server, options);
  registerGetIndexStatus(server, options);
  registerClearIndex(server, options);
  registerQueryGraph(server, options);
  registerGetNode(server, options);
  registerEmitNode(server, options);
  registerLink(server, options);
  registerSetActiveTopic(server, options);
}
