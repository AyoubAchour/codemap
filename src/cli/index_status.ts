import { getSourceIndexStatus } from "../source_index.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export async function indexStatus(
  options: GlobalOptions,
): Promise<CommandResult> {
  const status = await getSourceIndexStatus(options.repoRoot);
  return {
    exitCode: status.error ? 1 : 0,
    stdout: status.error
      ? undefined
      : `${JSON.stringify({ ok: true, ...status }, null, 2)}\n`,
    stderr: status.error
      ? `${JSON.stringify({ ok: false, ...status }, null, 2)}\n`
      : undefined,
  };
}
