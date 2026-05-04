import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { clearSourceIndex } from "../source_index.js";
import type { ToolOptions } from "./query_graph.js";

export function registerClearIndex(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "clear_index",
    {
      title: "Clear index",
      description:
        "Delete the rebuildable local source index cache. This does not modify .codemap/graph.json or any curated graph memory.",
      inputSchema: {},
    },
    async () => {
      const ok = await clearSourceIndex(options.repoRoot);
      const response = { ok, message: ok ? "source index cleared" : "clear failed" };
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );
}
