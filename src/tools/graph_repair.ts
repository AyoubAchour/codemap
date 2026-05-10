import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { inspectGraphRepair } from "../graph_repair.js";
import type { ToolOptions } from "./query_graph.js";

export function registerGraphRepair(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "graph_repair",
    {
      title: "Graph repair",
      description:
        "Plan source-anchor repair actions for graph memory without writing changes. Use after graph_health reports stale, legacy, or range-fresh anchors.",
      inputSchema: {
        include_deprecated: z
          .boolean()
          .optional()
          .describe(
            "If true, include deprecated nodes when planning source-anchor repairs. Default false.",
          ),
        issue_limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Maximum repair proposals to include in response arrays. Totals are still reported in summary. Default 50.",
          ),
      },
    },
    async ({ include_deprecated, issue_limit }) => {
      const response = await inspectGraphRepair(options.repoRoot, {
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
