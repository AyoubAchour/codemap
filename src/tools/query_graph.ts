import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphStore } from "../graph.js";
import { recordMetric } from "../metrics.js";
import { checkSourceStaleness } from "../staleness.js";

export interface ToolOptions {
  repoRoot: string;
}

export function registerQueryGraph(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "query_graph",
    {
      title: "Query graph",
      description:
        "Find nodes relevant to a task description. Call before planning any task that involves understanding this codebase. Returns the top matching nodes plus the edges connecting them.",
      inputSchema: {
        question: z
          .string()
          .min(1)
          .describe(
            "Natural-language description of the task or area you're investigating.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max number of nodes to return. Default 10."),
        check_staleness: z
          .boolean()
          .optional()
          .describe(
            "Whether to compare returned nodes' source hashes against current repo files. Default true.",
          ),
      },
    },
    async ({ question, limit, check_staleness }) => {
      const store = await GraphStore.load(options.repoRoot);
      const result = store.query(question, limit);
      const staleness =
        check_staleness === false
          ? { checked_sources: 0, stale_sources: [] }
          : await checkSourceStaleness(options.repoRoot, result.nodes);
      await recordMetric(options.repoRoot, (m) => {
        m.recordQuery(result.nodes.length);
        if (staleness.stale_sources.length > 0) {
          m.recordStaleRecheck(staleness.stale_sources.length);
        }
      });
      const response = { ...result, staleness };
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        // SDK requires structuredContent : Record<string, unknown>. Our typed
        // result satisfies that structurally; the cast is a TS index-signature
        // workaround, not a runtime change.
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );
}
