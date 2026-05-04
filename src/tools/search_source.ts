import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { searchSourceIndex } from "../source_index.js";
import type { ToolOptions } from "./query_graph.js";

export function registerSearchSource(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "search_source",
    {
      title: "Search source",
      description:
        "Search the rebuildable local source index for relevant code chunks. Use after query_graph when you need source discovery; inspect returned files before emitting durable graph knowledge.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Natural-language or keyword query describing code to find.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Maximum results to return. Default 5."),
        max_content_chars: z
          .number()
          .int()
          .min(200)
          .max(10000)
          .optional()
          .describe("Maximum chunk-content characters per result. Default 2400."),
      },
    },
    async ({ query, limit, max_content_chars }) => {
      const response = await searchSourceIndex(options.repoRoot, query, {
        limit,
        maxContentChars: max_content_chars,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );
}
