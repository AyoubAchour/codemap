import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GraphStore } from "../graph.js";
import type { ToolOptions } from "./query_graph.js";

export function registerGetNode(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "get_node",
    {
      title: "Get node",
      description:
        "Fetch the full content of a node by id. Resolves through aliases — passing an alias returns the canonical node. Returns null in `structuredContent` if no match.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe(
            "The node id (slug like 'auth/middleware') or any alias registered on it.",
          ),
      },
    },
    async ({ id }) => {
      const store = await GraphStore.load(options.repoRoot);
      const node = store.getNode(id);
      return {
        content: [{ type: "text", text: JSON.stringify(node) }],
      };
    },
  );
}
