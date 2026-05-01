import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GraphStore } from "../graph.js";
import { recordMetric } from "../metrics.js";
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
        "Mark the start of a new task. Always call this first when you begin understanding or modifying the codebase. The slug ('auth-bugfix', 'payment-refactor') tags every emit_node you make this turn for future search, and resets the per-turn emit cap (5). Without calling this, your emissions are untagged and your per-turn budget is stale.",
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
      // Begin a new turn entry in metrics. set_active_topic is the only tool
      // that does this; all other tools record into the current entry.
      await recordMetric(options.repoRoot, (m) => m.startTurn(name));
      const result = { ok: true, autoCreated: wasMissing };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
