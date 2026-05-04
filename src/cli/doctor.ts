import { inspectGraphHealth } from "../graph_health.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface DoctorFlags {
  includeDeprecated?: boolean;
  issueLimit?: number;
}

export async function doctor(
  flags: DoctorFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  const response = await inspectGraphHealth(options.repoRoot, {
    includeDeprecated: flags.includeDeprecated,
    issueLimit: flags.issueLimit,
  });

  if (!response.ok) {
    return {
      exitCode: 2,
      stderr: `${JSON.stringify(response, null, 2)}\n`,
    };
  }

  return {
    exitCode: response.summary.fresh ? 0 : 1,
    stdout: `${JSON.stringify(response, null, 2)}\n`,
  };
}
