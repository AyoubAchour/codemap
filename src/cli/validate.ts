import { GraphStore } from "../graph.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

/**
 * `codemap validate` — dry-run validator. Loads the graph (which runs
 * `validate()` + `applyRepairs()` per task-008), then reports what was
 * found *without* persisting anything. Useful for "is this graph clean?"
 * checks in CI or as a pre-commit hook.
 *
 * Exit codes:
 *   0 — no issues at all
 *   1 — warnings or repairs would have been applied (graph is loadable)
 *   2 — schema invalid (load() threw)
 */
export async function validate(options: GlobalOptions): Promise<CommandResult> {
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

  const result = store.validationResult();
  if (
    !result ||
    (result.errors.length === 0 &&
      result.warnings.length === 0 &&
      result.repairs.length === 0)
  ) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true, message: "no issues" })}\n`,
    };
  }

  return {
    exitCode: 1,
    stdout: `${JSON.stringify(
      {
        ok: false,
        warnings: result.warnings,
        repairs: result.repairs,
      },
      null,
      2,
    )}\n`,
  };
}
