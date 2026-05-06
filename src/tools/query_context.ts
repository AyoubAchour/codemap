import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  buildQueryContext,
  type SourceRefreshMode,
} from "../query_context.js";
import { recordMetric } from "../metrics.js";
import type { ToolOptions } from "./query_graph.js";

export function registerQueryContext(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "query_context",
    {
      title: "Query context",
      description:
        "Return a fused planning context for repo work: quality-ranked graph-memory matches with trust metadata, source-index status/search with score breakdowns, optional bounded impact context, deduplicated related graph nodes, warnings, and next steps.",
      inputSchema: {
        question: z
          .string()
          .min(1)
          .describe(
            "Natural-language description of the codebase task or area you're investigating.",
          ),
        graph_limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max graph nodes to return. Default 10."),
        source_limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Max source chunks to return. Default 5."),
        max_content_chars: z
          .number()
          .int()
          .min(200)
          .max(10000)
          .optional()
          .describe("Maximum chunk-content characters per source result. Default 2400."),
        dependency_limit: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe(
            "Max import/importer context entries per source result. Default 3.",
          ),
        include_impact: z
          .boolean()
          .optional()
          .describe(
            "When true, include bounded symbol/file impact context; when omitted, query_context auto-includes it for clear symbol/file queries.",
          ),
        impact_limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Maximum impact entries per category. Default 5."),
        refresh_index: z
          .enum(["never", "if_missing", "if_stale"])
          .optional()
          .describe(
            "Whether to rebuild the source index before searching. Default if_missing.",
          ),
      },
    },
    async ({
      question,
      graph_limit,
      source_limit,
      max_content_chars,
      dependency_limit,
      include_impact,
      impact_limit,
      refresh_index,
    }) => {
      const response = await buildQueryContext(options.repoRoot, question, {
        graphLimit: graph_limit,
        sourceLimit: source_limit,
        maxContentChars: max_content_chars,
        dependencyLimit: dependency_limit,
        includeImpact: include_impact,
        impactLimit: impact_limit,
        refreshIndex: refresh_index as SourceRefreshMode | undefined,
      });
      await recordMetric(options.repoRoot, (m) => {
        m.recordQuery(response.graph.nodes.length);
        if (response.graph.staleness.stale_sources.length > 0) {
          m.recordStaleRecheck(response.graph.staleness.stale_sources.length);
        }
      });
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );
}
