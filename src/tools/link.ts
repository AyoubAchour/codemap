import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GraphStore } from "../graph.js";
import { EdgeKindSchema } from "../schema.js";
import type { ToolOptions } from "./query_graph.js";

export function registerLink(server: McpServer, options: ToolOptions): void {
  server.registerTool(
    "link",
    {
      title: "Link two nodes",
      description:
        "Create or update an edge between two nodes. Idempotent: same (from, to, kind) updates the note rather than creating a duplicate. Use the existing edge-kind enum (imports, calls, depends_on, implements, replaces, contradicts, derived_from, mirrors) — invented kinds are rejected.",
      inputSchema: {
        from: z.string().min(1).describe("Source node id."),
        to: z.string().min(1).describe("Target node id."),
        kind: EdgeKindSchema.describe(
          "Edge kind. Must be one of the V1_SPEC §6.2 enum values.",
        ),
        note: z
          .string()
          .optional()
          .describe("Optional one-line context describing the relationship."),
      },
    },
    async ({ from, to, kind, note }) => {
      const store = await GraphStore.load(options.repoRoot);
      store.ensureEdge(from, to, kind, note);
      await store.save();
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      };
    },
  );
}
