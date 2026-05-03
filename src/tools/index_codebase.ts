import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { scanSourceIndex } from "../source_index.js";
import type { ToolOptions } from "./query_graph.js";

export function registerIndexCodebase(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "index_codebase",
    {
      title: "Index codebase",
      description:
        "Build the rebuildable local source index for this repo. This indexes source chunks for discovery only; it does not create graph nodes or write curated memory.",
      inputSchema: {
        max_file_bytes: z
          .number()
          .int()
          .min(1024)
          .optional()
          .describe(
            "Skip source files larger than this many bytes. Default 262144.",
          ),
      },
    },
    async ({ max_file_bytes }) => {
      const index = await scanSourceIndex(options.repoRoot, {
        maxFileBytes: max_file_bytes,
      });
      const response = {
        ok: true,
        updated_at: index.updated_at,
        stats: index.stats,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );
}
