import { scanSourceIndex } from "../source_index.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface ScanFlags {
  maxFileBytes?: number;
}

export async function scan(
  flags: ScanFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  try {
    const index = await scanSourceIndex(options.repoRoot, {
      maxFileBytes: flags.maxFileBytes,
    });
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(
        {
          ok: true,
          updated_at: index.updated_at,
          stats: index.stats,
        },
        null,
        2,
      )}\n`,
    };
  } catch (err) {
    return {
      exitCode: 1,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "SCAN_FAILED", message: String(err) },
      })}\n`,
    };
  }
}
