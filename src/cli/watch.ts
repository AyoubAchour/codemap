import {
  getSourceWatchStatus,
  refreshSourceIndexIfNeeded,
  watchSourceIndex,
  type SourceWatchEvent,
} from "../watch_index.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface WatchFlags {
  once?: boolean;
  status?: boolean;
  intervalMs?: number;
  maxFileBytes?: number;
}

export interface WatchLiveOptions extends GlobalOptions {
  write?: (text: string) => void;
  signal?: AbortSignal;
}

export async function watch(
  flags: WatchFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  try {
    if (flags.status) {
      const status = await getSourceWatchStatus(options.repoRoot, {
        intervalMs: flags.intervalMs,
      });
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(status, null, 2)}\n`,
      };
    }

    const result = await refreshSourceIndexIfNeeded(options.repoRoot, {
      intervalMs: flags.intervalMs,
      maxFileBytes: flags.maxFileBytes,
    });
    return {
      exitCode: result.watcher.last_result === "error" ? 1 : 0,
      stdout: `${JSON.stringify(result, null, 2)}\n`,
    };
  } catch (err) {
    return {
      exitCode: 1,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "WATCH_FAILED", message: String(err) },
      })}\n`,
    };
  }
}

export async function watchLive(
  flags: WatchFlags,
  options: WatchLiveOptions,
): Promise<CommandResult> {
  const write = options.write ?? (() => {});
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await watchSourceIndex(options.repoRoot, {
      intervalMs: flags.intervalMs,
      maxFileBytes: flags.maxFileBytes,
      signal,
      onEvent: (event: SourceWatchEvent) => {
        write(`${JSON.stringify(event)}\n`);
      },
    });
    return { exitCode: 0 };
  } catch (err) {
    return {
      exitCode: 1,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "WATCH_FAILED", message: String(err) },
      })}\n`,
    };
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
