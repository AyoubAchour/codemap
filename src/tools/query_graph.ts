import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GraphStore } from "../graph.js";
import { recordMetric } from "../metrics.js";

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
      },
    },
    async ({ question, limit }) => {
      const store = await GraphStore.load(options.repoRoot);
      const result = store.query(question, limit);
      await recordMetric(options.repoRoot, (m) =>
        m.recordQuery(result.nodes.length),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        // SDK requires structuredContent : Record<string, unknown>. Our typed
        // result satisfies that structurally; the cast is a TS index-signature
        // workaround, not a runtime change.
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
