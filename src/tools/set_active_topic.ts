import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GraphStore } from "../graph.js";
import { setActiveTopic } from "./_active_topic.js";
import type { ToolOptions } from "./query_graph.js";

export function registerSetActiveTopic(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "set_active_topic",
    {
      title: "Set active topic",
      description:
        "Set the active topic for this session. All subsequent emit_node calls auto-tag with this topic. If the topic doesn't exist in topics{} yet, it's added. Per V1_SPEC §7.5, this also resets the per-turn emission cap counter (enforced in task-014's emit_node).",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe(
            "Short slug for the current task — e.g. 'auth-bugfix', 'payment-refactor'.",
          ),
      },
    },
    async ({ name }) => {
      const store = await GraphStore.load(options.repoRoot);
      const wasMissing = !store._data().topics[name];
      store.ensureTopic(name);
      if (wasMissing) {
        await store.save();
      }
      setActiveTopic(name);
      const result = { ok: true, autoCreated: wasMissing };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
