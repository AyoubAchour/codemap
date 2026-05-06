import {
  setupCodemap,
  type SetupClient,
} from "../setup.js";
import type { CommandResult } from "./_types.js";

export interface SetupFlags {
  client?: SetupClient[];
  check?: boolean;
  force?: boolean;
  command?: string;
}

export async function setup(flags: SetupFlags): Promise<CommandResult> {
  if (flags.check && flags.force) {
    return {
      exitCode: 1,
      stderr:
        "error: --check is read-only and cannot be combined with --force\n",
    };
  }

  try {
    const response = await setupCodemap({
      clients: flags.client,
      check: flags.check,
      force: flags.force,
      command: flags.command,
    });
    const hasError = response.clients.some((client) => client.status === "error");
    const hasMissing = response.clients.some(
      (client) => flags.check && client.status === "missing",
    );
    return {
      exitCode: hasError ? 2 : hasMissing || response.warnings.length > 0 ? 1 : 0,
      stdout: `${JSON.stringify(response, null, 2)}\n`,
    };
  } catch (err) {
    return {
      exitCode: 1,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "SETUP_FAILED", message: String(err) },
      })}\n`,
    };
  }
}
