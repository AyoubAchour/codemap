import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAgenticSurfaces } from "./agentic_surfaces.js";
import { registerChangesContext } from "./tools/changes_context.js";
import { registerClearIndex } from "./tools/clear_index.js";
import { registerEmitNode } from "./tools/emit_node.js";
import { registerGetIndexStatus } from "./tools/get_index_status.js";
import { registerGetNode } from "./tools/get_node.js";
import { registerGraphHealth } from "./tools/graph_health.js";
import { registerGraphRepair } from "./tools/graph_repair.js";
import { registerIndexCodebase } from "./tools/index_codebase.js";
import { registerLink } from "./tools/link.js";
import { registerQueryContext } from "./tools/query_context.js";
import { registerQueryGraph } from "./tools/query_graph.js";
import { registerSearchSource } from "./tools/search_source.js";
import { registerSetActiveTopic } from "./tools/set_active_topic.js";
import { registerSuggestWriteback } from "./tools/suggest_writeback.js";

export interface RegisterToolsOptions {
  /** Path to the repo root; `<repoRoot>/.codemap/graph.json` is the store. */
  repoRoot: string;
}

/**
 * Register Codemap's MCP tools onto the given server.
 *
 * Agent-facing MCP surfaces:
 *  - resources/list + resources/read for lifecycle guidance, source status,
 *    graph health, and generated repo guidance
 *  - prompts/list + prompts/get for planning, diff review, and writeback
 *
 * Source discovery:
 *  - index_codebase
 *  - query_context   (fused graph/source/dependency/impact planning context)
 *  - changes_context (git diff impact + writeback planning context)
 *  - search_source   (chunk search with optional dependency + impact context)
 *  - get_index_status
 *  - clear_index
 *
 * Curated memory graph:
 *  - graph_health
 *  - graph_repair    (read-only source-anchor repair proposals)
 *  - query_graph
 *  - get_node
 *  - suggest_writeback (read-only end-of-task writeback prompts)
 *  - emit_node       (collision-aware; per-turn cap)
 *  - link
 *  - set_active_topic
 */
export function registerTools(
  server: McpServer,
  options: RegisterToolsOptions,
): void {
  registerAgenticSurfaces(server, options);
  registerIndexCodebase(server, options);
  registerQueryContext(server, options);
  registerChangesContext(server, options);
  registerSearchSource(server, options);
  registerGetIndexStatus(server, options);
  registerClearIndex(server, options);
  registerGraphHealth(server, options);
  registerGraphRepair(server, options);
  registerQueryGraph(server, options);
  registerGetNode(server, options);
  registerSuggestWriteback(server, options);
  registerEmitNode(server, options);
  registerLink(server, options);
  registerSetActiveTopic(server, options);
}
