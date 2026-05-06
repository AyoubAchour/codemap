import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  buildChangesContext,
  type ChangesRefreshMode,
} from "../changes_context.js";
import type { ToolOptions } from "./query_graph.js";

export function registerChangesContext(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "changes_context",
    {
      title: "Changes context",
      description:
        "Inspect the current git diff (or a base ref), map changed files/symbols to source-index impact context, stale graph nodes, likely affected tests/docs, and read-only writeback suggestions.",
      inputSchema: {
        base_ref: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional git base ref to compare against HEAD. Omit to inspect staged, unstaged, and untracked working-tree changes.",
          ),
        include_untracked: z
          .boolean()
          .optional()
          .describe(
            "When inspecting the working tree, include untracked files. Default true.",
          ),
        refresh_index: z
          .enum(["never", "if_missing", "if_stale"])
          .optional()
          .describe(
            "Whether to rebuild the source index before mapping impact. Default if_missing.",
          ),
        file_limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum changed files to analyze in detail. Default 12."),
        dependency_limit: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe("Maximum import/importer context entries per changed file. Default 3."),
        impact_limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Maximum impact entries per category. Default 5."),
        max_content_chars: z
          .number()
          .int()
          .min(200)
          .max(5000)
          .optional()
          .describe("Maximum preview characters per impact/dependency entry. Default 1200."),
        include_writeback: z
          .boolean()
          .optional()
          .describe(
            "When false, omit read-only writeback suggestions. Default true.",
          ),
      },
    },
    async ({
      base_ref,
      include_untracked,
      refresh_index,
      file_limit,
      dependency_limit,
      impact_limit,
      max_content_chars,
      include_writeback,
    }) => {
      const response = await buildChangesContext(options.repoRoot, {
        baseRef: base_ref,
        includeUntracked: include_untracked,
        refreshIndex: refresh_index as ChangesRefreshMode | undefined,
        fileLimit: file_limit,
        dependencyLimit: dependency_limit,
        impactLimit: impact_limit,
        maxContentChars: max_content_chars,
        includeWriteback: include_writeback,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );
}
