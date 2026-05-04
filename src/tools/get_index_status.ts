import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getSourceIndexStatus } from "../source_index.js";
import type { ToolOptions } from "./query_graph.js";

export function registerGetIndexStatus(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "get_index_status",
    {
      title: "Get index status",
      description:
        "Report whether the local source index exists and whether indexed files look fresh. Use before search_source if search results seem stale or missing.",
      inputSchema: {},
    },
    async () => {
      const response = await getSourceIndexStatus(options.repoRoot);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );
}
