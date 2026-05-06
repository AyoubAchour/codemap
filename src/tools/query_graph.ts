import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphStore } from "../graph.js";
import {
  filterStalenessReportForNodes,
  rankGraphResultByQuality,
} from "../graph_quality.js";
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
        "Find nodes relevant to a task description. Call before planning any task that involves understanding this codebase. Returns quality-ranked nodes, match reasons, quality metadata, and connecting edges.",
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
      const resultLimit = limit ?? 10;
      const candidateLimit = Math.min(
        50,
        Math.max(resultLimit * 3, resultLimit + 10),
      );
      const sourceChecksEnabled = check_staleness !== false;
      const store = await GraphStore.load(options.repoRoot);
      const candidates = store.query(question, candidateLimit);
      const candidateStaleness =
        sourceChecksEnabled === false
          ? { checked_sources: 0, stale_sources: [] }
          : await checkSourceStaleness(options.repoRoot, candidates.nodes);
      const result = rankGraphResultByQuality(candidates, candidateStaleness, {
        limit: resultLimit,
        sourceChecksEnabled,
      });
      const staleness = filterStalenessReportForNodes(
        candidateStaleness,
        result.nodes,
        sourceChecksEnabled,
      );
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
