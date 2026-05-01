import type { CommandResult } from "./_types.js";

/**
 * `codemap rollup` — compute the metrics weekly rollup.
 *
 * Stub in task-015. Real implementation lands in task-016 along with the
 * rest of the telemetry pipeline. The CLI command is registered now (in
 * task-015) so the command surface is complete; only the rollup algorithm
 * is deferred.
 */
export async function rollup(): Promise<CommandResult> {
  return {
    exitCode: 0,
    stdout:
      "rollup: not yet implemented — landing in task-016 with the telemetry pipeline.\n",
  };
}
