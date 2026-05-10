import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { inspectGraphHealth } from "./graph_health.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { generateRepoSkills } from "./repo_guidance.js";
import { getSourceIndexStatus } from "./source_index.js";

export interface AgenticSurfacesOptions {
  /** Path to the repo root; `<repoRoot>/.codemap/graph.json` is the store. */
  repoRoot: string;
}

const MARKDOWN_MIME = "text/markdown";
const JSON_MIME = "application/json";

export function registerAgenticSurfaces(
  server: McpServer,
  options: AgenticSurfacesOptions,
): void {
  registerLifecycleResource(server);
  registerSourceStatusResource(server, options);
  registerGraphHealthResource(server, options);
  registerRepoGuidanceResource(server, options);
  registerPlanningPrompts(server);
}

function registerLifecycleResource(server: McpServer): void {
  server.registerResource(
    "codemap-lifecycle",
    "codemap://guidance/lifecycle",
    {
      title: "Codemap lifecycle guidance",
      description:
        "Repo-scoped Codemap lifecycle policy mirrored from server instructions.",
      mimeType: MARKDOWN_MIME,
    },
    async (uri) => textResource(uri.href, SERVER_INSTRUCTIONS, MARKDOWN_MIME),
  );
}

function registerSourceStatusResource(
  server: McpServer,
  options: AgenticSurfacesOptions,
): void {
  server.registerResource(
    "codemap-source-index-status",
    "codemap://status/source-index",
    {
      title: "Codemap source index status",
      description:
        "Read-only source-index freshness and coverage status for this repository.",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      const status = await getSourceIndexStatus(options.repoRoot);
      return jsonResource(uri.href, status);
    },
  );
}

function registerGraphHealthResource(
  server: McpServer,
  options: AgenticSurfacesOptions,
): void {
  server.registerResource(
    "codemap-graph-health",
    "codemap://status/graph-health",
    {
      title: "Codemap graph health",
      description:
        "Read-only graph validator and source-anchor health for curated memory.",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      const health = await inspectGraphHealth(options.repoRoot, {
        issueLimit: 25,
      });
      return jsonResource(uri.href, health);
    },
  );
}

function registerRepoGuidanceResource(
  server: McpServer,
  options: AgenticSurfacesOptions,
): void {
  server.registerResource(
    "codemap-repo-guidance",
    "codemap://guidance/repo-skill",
    {
      title: "Generated Codemap repo guidance",
      description:
        "Read-only generated repo guidance from source index and curated memory summaries.",
      mimeType: MARKDOWN_MIME,
    },
    async (uri) => {
      const guidance = await generateRepoSkills(options.repoRoot, {
        check: true,
        stdout: true,
      });
      return textResource(uri.href, guidance.content ?? "", MARKDOWN_MIME);
    },
  );
}

function registerPlanningPrompts(server: McpServer): void {
  server.registerPrompt(
    "codemap_plan",
    {
      title: "Codemap planning prompt",
      description:
        "Plan repository work with the Codemap lifecycle, source index, and graph memory.",
      argsSchema: {
        task: z
          .string()
          .optional()
          .describe("Repository task or behavior being investigated."),
      },
    },
    async ({ task }) =>
      promptText(`Use Codemap for this repository task: ${task ?? "the current task"}.

Follow the repo-only lifecycle:
1. Call set_active_topic with a short slug.
2. Call query_context for the task before planning.
3. Treat source hits as discovery hints and inspect real files before relying on them.
4. If graph memory is stale or low-trust, call graph_health before relying on it.
5. Keep any final writeback limited to durable repo-local decisions, invariants, gotchas, or confirmed relationships.`),
  );

  server.registerPrompt(
    "codemap_diff_review",
    {
      title: "Codemap diff review prompt",
      description:
        "Review a repository diff through changes_context before summarizing or committing.",
      argsSchema: {
        focus: z
          .string()
          .optional()
          .describe("Review focus, such as release readiness or test impact."),
      },
    },
    async ({ focus }) =>
      promptText(`Review the current repository diff with Codemap.

Focus: ${focus ?? "behavioral impact, likely tests, stale graph anchors, and writeback opportunities"}.

Required steps:
1. Call changes_context before summarizing, reviewing, or committing.
2. Inspect changed files and any likely affected tests/docs from the response.
3. Treat impact context as planning guidance, not proof.
4. Call suggest_writeback near the end if the diff reveals durable repo-local lessons.`),
  );

  server.registerPrompt(
    "codemap_writeback",
    {
      title: "Codemap writeback prompt",
      description:
        "Close repository work with read-only writeback suggestions and careful graph capture.",
      argsSchema: {
        summary: z
          .string()
          .optional()
          .describe("Short summary of what was learned or changed."),
      },
    },
    async ({ summary }) =>
      promptText(`Close this repository task with Codemap writeback discipline.

Work summary: ${summary ?? "the repository work completed in this turn"}.

Required steps:
1. Call suggest_writeback with inspected or modified files and the work summary.
2. Only emit_node for durable repo-local decisions, invariants, gotchas, or confirmed relationships.
3. Anchor every node to real repo-relative files you inspected.
4. Do not write graph memory for unrelated Q&A, web research, installs, recommendations, or external documentation lookup.`),
  );
}

function promptText(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text,
        },
      },
    ],
  };
}

function textResource(uri: string, text: string, mimeType: string) {
  return {
    contents: [
      {
        uri,
        text,
        mimeType,
      },
    ],
  };
}

function jsonResource(uri: string, value: unknown) {
  return textResource(uri, JSON.stringify(value, null, 2), JSON_MIME);
}
