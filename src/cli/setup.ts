import { type SetupClient, type SetupScope, setupCodemap } from "../setup.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface SetupFlags {
  client?: SetupClient[];
  check?: boolean;
  force?: boolean;
  dryRun?: boolean;
  captureHooks?: boolean;
  captureCommand?: string;
  command?: string;
  scope?: SetupScope;
}

export async function setup(
  flags: SetupFlags,
  globals?: GlobalOptions,
): Promise<CommandResult> {
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
      dryRun: flags.dryRun,
      captureHooks: flags.captureHooks,
      captureCommand: flags.captureCommand,
      command: flags.command,
      scope: flags.scope,
      repoRoot: globals?.repoRoot,
    });
    const hasError = response.clients.some(
      (client) => client.status === "error",
    );
    const hasCaptureError = response.capture_hooks.some(
      (hook) => hook.status === "error",
    );
    const hasMissing = response.clients.some(
      (client) => flags.check && client.status === "missing",
    );
    const hasMissingCaptureHook = response.capture_hooks.some(
      (hook) =>
        flags.check && (hook.status === "missing" || hook.status === "stale"),
    );
    return {
      exitCode:
        hasError || hasCaptureError
          ? 2
          : hasMissing || hasMissingCaptureHook || response.warnings.length > 0
            ? 1
            : 0,
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
