import { GraphStore } from "../graph.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface DeprecateFlags {
  reason?: string;
}

/**
 * `codemap deprecate <id> [--reason <r>]` — sugar for setting status to
 * "deprecated". When --reason is supplied, prepends `[deprecated: <reason>]`
 * to the node's summary, mirroring the force_new pattern from task-014.
 *
 * Exit codes: 0 = ok, 1 = node not found, 2 = schema-invalid.
 */
export async function deprecate(
  id: string,
  flags: DeprecateFlags,
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

  const patch: Record<string, unknown> = { status: "deprecated" };
  if (flags.reason !== undefined && flags.reason.length > 0) {
    patch.summary = `[deprecated: ${flags.reason}] ${node.summary}`;
  }

  store.overrideNode(node.id, patch);
  await store.save();

  return {
    exitCode: 0,
    stdout: `${JSON.stringify(
      {
        ok: true,
        id: node.id,
        node: store.getNode(node.id),
      },
      null,
      2,
    )}\n`,
  };
}
