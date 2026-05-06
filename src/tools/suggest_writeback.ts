import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildWritebackSuggestions } from "../writeback_suggestions.js";
import { getActiveTopic } from "./_active_topic.js";
import type { ToolOptions } from "./query_graph.js";

export function registerSuggestWriteback(
	server: McpServer,
	options: ToolOptions,
): void {
	server.registerTool(
		"suggest_writeback",
		{
			title: "Suggest writeback",
			description:
				"Read-only end-of-task helper for repo work. Suggests possible durable Codemap writeback opportunities from active topic, optional inspected/modified files, optional work summary, and optional git changed files. Never creates graph nodes or links.",
			inputSchema: {
				inspected_files: z
					.array(z.string().min(1))
					.optional()
					.describe(
						"Repo-relative files the agent inspected. Optional, but improves source-anchor suggestions.",
					),
				modified_files: z
					.array(z.string().min(1))
					.optional()
					.describe(
						"Repo-relative files the agent modified. Optional; used only as read-only evidence.",
					),
				work_summary: z
					.string()
					.optional()
					.describe(
						"Short summary of what changed or what was learned during the repo task.",
					),
				include_git: z
					.boolean()
					.optional()
					.describe(
						"When true, inspect git changed/untracked files as additional read-only evidence. Default false for MCP clients.",
					),
				limit: z
					.number()
					.int()
					.min(0)
					.max(20)
					.optional()
					.describe("Maximum suggestions to return. Default 6."),
			},
		},
		async ({
			inspected_files,
			modified_files,
			work_summary,
			include_git,
			limit,
		}) => {
			const response = await buildWritebackSuggestions(options.repoRoot, {
				activeTopic: getActiveTopic(),
				inspectedFiles: inspected_files,
				modifiedFiles: modified_files,
				workSummary: work_summary,
				includeGit: include_git ?? false,
				limit,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(response) }],
				structuredContent: response as unknown as Record<string, unknown>,
			};
		},
	);
}
