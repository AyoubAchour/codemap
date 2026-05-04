import {
  buildQueryContext,
  type SourceRefreshMode,
} from "../query_context.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface ContextFlags {
  graphLimit?: number;
  sourceLimit?: number;
  maxContentChars?: number;
  dependencyLimit?: number;
  refreshIndex?: SourceRefreshMode;
}

export async function context(
  question: string,
  flags: ContextFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  try {
    const response = await buildQueryContext(options.repoRoot, question, {
      graphLimit: flags.graphLimit,
      sourceLimit: flags.sourceLimit,
      maxContentChars: flags.maxContentChars,
      dependencyLimit: flags.dependencyLimit,
      refreshIndex: flags.refreshIndex,
    });

    return {
      exitCode: 0,
      stdout: `${JSON.stringify(response, null, 2)}\n`,
    };
  } catch (err) {
    return {
      exitCode: 1,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "CONTEXT_FAILED", message: String(err) },
      })}\n`,
    };
  }
}
