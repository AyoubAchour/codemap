import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { inspectGraphHealth } from "../graph_health.js";
import type { ToolOptions } from "./query_graph.js";

export function registerGraphHealth(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "graph_health",
    {
      title: "Graph health",
      description:
        "Inspect curated graph health: validator warnings/repairs plus source-anchor staleness for active nodes. Read-only; use when query_context warns about stale graph memory.",
      inputSchema: {
        include_deprecated: z
          .boolean()
          .optional()
          .describe(
            "If true, include deprecated nodes when checking source-anchor staleness. Default false.",
          ),
        issue_limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Maximum stale source entries to include in response arrays. Totals are still reported in summary. Default 50.",
          ),
      },
    },
    async ({ include_deprecated, issue_limit }) => {
      const response = await inspectGraphHealth(options.repoRoot, {
        includeDeprecated: include_deprecated,
        issueLimit: issue_limit,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );
}
