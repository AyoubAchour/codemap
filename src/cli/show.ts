import { GraphStore } from "../graph.js";
import type { Edge, EdgeKind } from "../types.js";
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
    const lastBar = key.lastIndexOf("|");
    if (lastBar <= 0) continue;
    const secondLastBar = key.lastIndexOf("|", lastBar - 1);
    if (secondLastBar <= 0) continue;
    const from = key.slice(0, secondLastBar);
    const to = key.slice(secondLastBar + 1, lastBar);
    const kind = key.slice(lastBar + 1) as EdgeKind;
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
