import { searchSourceIndex } from "../source_index.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface SearchSourceFlags {
  limit?: number;
  maxContentChars?: number;
  dependencyLimit?: number;
}

export async function searchSource(
  query: string,
  flags: SearchSourceFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  const response = await searchSourceIndex(options.repoRoot, query, {
    limit: flags.limit,
    maxContentChars: flags.maxContentChars,
    dependencyLimit: flags.dependencyLimit,
  });

  if (!response.ok) {
    return {
      exitCode: 1,
      stderr: `${JSON.stringify(response, null, 2)}\n`,
    };
  }

  return {
    exitCode: 0,
    stdout: `${JSON.stringify(response, null, 2)}\n`,
  };
}
