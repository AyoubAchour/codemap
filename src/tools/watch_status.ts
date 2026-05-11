import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getSourceWatchStatus } from "../watch_index.js";
import type { ToolOptions } from "./query_graph.js";

export function registerWatchStatus(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "watch_status",
    {
      title: "Get watch status",
      description:
        "Report source-index watcher state and freshness without refreshing the index or writing graph memory.",
      inputSchema: {},
    },
    async () => {
      const response = await getSourceWatchStatus(options.repoRoot);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );
}
