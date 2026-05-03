import { clearSourceIndex } from "../source_index.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export async function clearIndex(
  options: GlobalOptions,
): Promise<CommandResult> {
  const ok = await clearSourceIndex(options.repoRoot);
  return {
    exitCode: ok ? 0 : 1,
    stdout: ok
      ? `${JSON.stringify({ ok: true, message: "source index cleared" })}\n`
      : undefined,
    stderr: ok
      ? undefined
      : `${JSON.stringify({
          ok: false,
          error: { code: "CLEAR_INDEX_FAILED" },
        })}\n`,
  };
}
