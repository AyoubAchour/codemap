import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  buildRecallContext,
  type RecallContextMode,
  type RecallRefreshMode,
} from "../recall_context.js";
import type { ToolOptions } from "./query_graph.js";

export function registerRecallContext(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "recall_context",
    {
      title: "Recall context",
      description:
        "Return a compact budgeted recall packet for repo work with explicit graph/source provenance, trust/freshness warnings, source anchors, and omitted-result counts.",
      inputSchema: {
        question: z
          .string()
          .min(1)
          .describe("Natural-language question or task to recall context for."),
        mode: z
          .enum(["mixed", "graph", "source"])
          .optional()
          .describe("Recall mode. mixed returns graph and source hits. Default mixed."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Maximum recall results to return. Default 5."),
        budget_bytes: z
          .number()
          .int()
          .min(500)
          .max(100000)
          .optional()
          .describe("Maximum response bytes for the recall packet. Default 4000."),
        max_content_chars: z
          .number()
          .int()
          .min(80)
          .max(2000)
          .optional()
          .describe(
            "Maximum characters of source snippet or graph summary per result. Default 220.",
          ),
        files: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional repo-relative files to prefer or constrain recall."),
        symbols: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional symbols or terms to prefer in recall."),
        refresh_index: z
          .enum(["never", "if_missing", "if_stale"])
          .optional()
          .describe(
            "Whether to rebuild the source index before source recall. Default if_missing.",
          ),
        include_capture_summary: z
          .boolean()
          .optional()
          .describe(
            "When true, include rebuildable capture session/profile summaries as recall evidence. Default false.",
          ),
      },
    },
    async ({
      question,
      mode,
      limit,
      budget_bytes,
      max_content_chars,
      files,
      symbols,
      refresh_index,
      include_capture_summary,
    }) => {
      const response = await buildRecallContext(options.repoRoot, question, {
        mode: mode as RecallContextMode | undefined,
        limit,
        budgetBytes: budget_bytes,
        maxContentChars: max_content_chars,
        files,
        symbols,
        refreshIndex: refresh_index as RecallRefreshMode | undefined,
        includeCaptureSummary: include_capture_summary,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );
}
