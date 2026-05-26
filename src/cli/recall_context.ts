import {
  buildRecallContext,
  type RecallContextMode,
  type RecallRefreshMode,
} from "../recall_context.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface RecallContextFlags {
  mode?: RecallContextMode;
  limit?: number;
  budgetBytes?: number;
  maxContentChars?: number;
  refreshIndex?: RecallRefreshMode;
  file?: string[];
  symbol?: string[];
  includeCaptureSummary?: boolean;
}

export async function recallContext(
  question: string,
  flags: RecallContextFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  try {
    const response = await buildRecallContext(options.repoRoot, question, {
      mode: flags.mode,
      limit: flags.limit,
      budgetBytes: flags.budgetBytes,
      maxContentChars: flags.maxContentChars,
      refreshIndex: flags.refreshIndex,
      files: flags.file,
      symbols: flags.symbol,
      includeCaptureSummary: flags.includeCaptureSummary,
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
        error: { code: "RECALL_CONTEXT_FAILED", message: String(err) },
      })}\n`,
    };
  }
}
