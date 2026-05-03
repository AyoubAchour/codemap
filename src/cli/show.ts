import { GraphStore } from "../graph.js";
import { parseEdgeKey } from "../schema.js";
import type { Edge } from "../types.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

/**
 * `codemap show <id>` — print one node + the edges where it appears as
 * `from` or `to`. `id` may be the canonical node id or any alias.
 *
 * Exit codes: 0 = found, 1 = not found, 2 = schema-invalid graph.
 */
export async function show(
  id: string,
  options: GlobalOptions,
): Promise<CommandResult> {
  let store: GraphStore;
  try {
    store = await GraphStore.load(options.repoRoot);
  } catch (err) {
    return {
      exitCode: 2,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "SCHEMA_INVALID", message: String(err) },
      })}\n`,
    };
  }

  const node = store.getNode(id);
  if (!node) {
    return {
      exitCode: 1,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "NODE_NOT_FOUND", message: `node not found: ${id}` },
      })}\n`,
    };
  }

  const edges: Edge[] = [];
  for (const [key, value] of Object.entries(store._data().edges)) {
    const parsed = parseEdgeKey(key);
    if (!parsed) continue;
    const { from, to, kind } = parsed;
    if (from === node.id || to === node.id) {
      const edge: Edge = { from, to, kind };
      if (value.note !== undefined) edge.note = value.note;
      edges.push(edge);
    }
  }

  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ ok: true, node, edges }, null, 2)}\n`,
  };
}
