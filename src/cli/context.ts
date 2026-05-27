import {
  buildQueryContext,
  type QueryContextMode,
  type SourceRefreshMode,
} from "../query_context.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface ContextFlags {
  mode?: QueryContextMode;
  graphLimit?: number;
  sourceLimit?: number;
  maxContentChars?: number;
  dependencyLimit?: number;
  refreshIndex?: SourceRefreshMode;
  includeImpact?: boolean;
  impactLimit?: number;
  budgetBytes?: number;
}

export async function context(
  question: string,
  flags: ContextFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  try {
    const response = await buildQueryContext(options.repoRoot, question, {
      mode: flags.mode,
      graphLimit: flags.graphLimit,
      sourceLimit: flags.sourceLimit,
      maxContentChars: flags.maxContentChars,
      dependencyLimit: flags.dependencyLimit,
      refreshIndex: flags.refreshIndex,
      includeImpact: flags.includeImpact,
      impactLimit: flags.impactLimit,
      budgetBytes: flags.budgetBytes,
    });

    const stdout =
      flags.budgetBytes === undefined
        ? `${JSON.stringify(response, null, 2)}\n`
        : JSON.stringify(response);

    return {
      exitCode: 0,
      stdout,
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
