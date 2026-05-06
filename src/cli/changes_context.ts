import {
  buildChangesContext,
  type ChangesRefreshMode,
} from "../changes_context.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface ChangesContextFlags {
  baseRef?: string;
  includeUntracked?: boolean;
  refreshIndex?: ChangesRefreshMode;
  fileLimit?: number;
  dependencyLimit?: number;
  impactLimit?: number;
  maxContentChars?: number;
  noWriteback?: boolean;
}

export async function changesContext(
  flags: ChangesContextFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  try {
    const response = await buildChangesContext(options.repoRoot, {
      baseRef: flags.baseRef,
      includeUntracked: flags.includeUntracked,
      refreshIndex: flags.refreshIndex,
      fileLimit: flags.fileLimit,
      dependencyLimit: flags.dependencyLimit,
      impactLimit: flags.impactLimit,
      maxContentChars: flags.maxContentChars,
      includeWriteback: flags.noWriteback ? false : undefined,
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
        error: { code: "CHANGES_CONTEXT_FAILED", message: String(err) },
      })}\n`,
    };
  }
}
