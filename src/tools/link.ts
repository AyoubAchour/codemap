import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GraphStore } from "../graph.js";
import { recordMetric } from "../metrics.js";
import { EdgeKindSchema } from "../schema.js";
import type { ToolOptions } from "./query_graph.js";

// Node-id constraint mirrors NodeIdSchema in src/schema.ts: non-empty, no '|'
// (which is reserved as the edge-key separator).
const NodeIdInput = z
  .string()
  .min(1)
  .regex(/^[^|]+$/, "node id cannot contain '|'");

export function registerLink(server: McpServer, options: ToolOptions): void {
  server.registerTool(
    "link",
    {
      title: "Link two nodes",
      description:
        "Create or update an edge between two existing nodes. Idempotent: same (from, to, kind) updates the note rather than creating a duplicate. Use the existing edge-kind enum (imports, calls, depends_on, implements, replaces, contradicts, derived_from, mirrors) — invented kinds are rejected. Both endpoints must already exist in the graph; pass an alias and it will resolve to the canonical id.",
      inputSchema: {
        from: NodeIdInput.describe(
          "Source node id (or any alias on it). Must already exist.",
        ),
        to: NodeIdInput.describe(
          "Target node id (or any alias on it). Must already exist.",
        ),
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

      // Verify both endpoints exist before writing. ensureEdge would otherwise
      // accept any string, save it, and the validator on next load() would
      // silently drop the dangling edge — leaving the agent with a false
      // success signal. Resolving through aliases gives the agent flexibility.
      const fromNode = store.getNode(from);
      if (!fromNode) {
        const result = {
          ok: false,
          error: {
            code: "NODE_NOT_FOUND",
            message: `'from' node not found in graph: ${from}`,
          },
        };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }
      const toNode = store.getNode(to);
      if (!toNode) {
        const result = {
          ok: false,
          error: {
            code: "NODE_NOT_FOUND",
            message: `'to' node not found in graph: ${to}`,
          },
        };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }

      // Use the canonical ids (in case the agent passed aliases) so the stored
      // edge key matches the nodes{} keys exactly. Otherwise the validator would
      // flag the edge as dangling on next load.
      store.ensureEdge(fromNode.id, toNode.id, kind, note);
      await store.save();
      await recordMetric(options.repoRoot, (m) => m.recordLink());

      const result = {
        ok: true,
        from: fromNode.id,
        to: toNode.id,
        kind,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
