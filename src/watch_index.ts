import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  getSourceIndexStatus,
  scanSourceIndex,
  type ScanSourceIndexOptions,
  type SourceIndexStatus,
} from "./source_index.js";

const WATCH_STATE_VERSION = 1 as const;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_ACTIVE_GRACE_MS = 15000;

export type WatchRefreshReason = "error" | "fresh" | "missing" | "stale";
export type WatchRefreshResult = "error" | "fresh" | "refreshed" | "stale";

export interface SourceWatchOptions extends ScanSourceIndexOptions {
  intervalMs?: number;
  now?: () => Date;
}

export interface SourceWatchState {
  version: typeof WATCH_STATE_VERSION;
  mode: "poll";
  pid: number;
  interval_ms: number;
  started_at: string;
  last_heartbeat_at: string;
  last_checked_at: string;
  last_result: WatchRefreshResult;
  refresh_count: number;
  last_refresh_at?: string;
  last_error?: string;
}

export interface SourceWatchStatusResponse {
  ok: true;
  source: SourceIndexStatus;
  watcher: {
    status_path: string;
    active: boolean;
    active_grace_ms: number;
    state: SourceWatchState | null;
  };
}

export interface SourceWatchIterationResponse {
  ok: true;
  refreshed: boolean;
  reason: WatchRefreshReason;
  source_before: SourceIndexStatus;
  source_after: SourceIndexStatus;
  watcher: SourceWatchState;
}

export interface SourceWatchEvent extends SourceWatchIterationResponse {
  event: "watch_tick";
}

export interface RunSourceWatchOptions extends SourceWatchOptions {
  signal?: AbortSignal;
  onEvent?: (event: SourceWatchEvent) => void;
}

export function sourceWatchStatusPath(repoRoot: string): string {
  return path.join(repoRoot, ".codemap", "index", "watch.json");
}

export async function getSourceWatchStatus(
  repoRoot: string,
  options: SourceWatchOptions = {},
): Promise<SourceWatchStatusResponse> {
  const state = await loadWatchState(repoRoot);
  return {
    ok: true,
    source: await getSourceIndexStatus(repoRoot),
    watcher: {
      status_path: sourceWatchStatusPath(repoRoot),
      active: isWatchStateActive(state, options),
      active_grace_ms: activeGraceMs(options),
      state,
    },
  };
}

export async function refreshSourceIndexIfNeeded(
  repoRoot: string,
  options: SourceWatchOptions = {},
): Promise<SourceWatchIterationResponse> {
  const before = await getSourceIndexStatus(repoRoot);
  const reason = refreshReason(before);
  let after = before;
  let lastError: string | undefined;
  if (reason !== "fresh") {
    try {
      await scanSourceIndex(repoRoot, {
        maxFileBytes: options.maxFileBytes,
      });
      after = await getSourceIndexStatus(repoRoot);
    } catch (err) {
      lastError = String(err);
      after = await getSourceIndexStatus(repoRoot);
    }
  }

  const previous = await loadWatchState(repoRoot);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const refreshed = reason !== "fresh" && !lastError && after.fresh;
  const lastResult: WatchRefreshResult = lastError
    ? "error"
    : refreshed
      ? "refreshed"
      : reason === "fresh"
        ? "fresh"
        : "stale";
  const state: SourceWatchState = {
    version: WATCH_STATE_VERSION,
    mode: "poll",
    pid: process.pid,
    interval_ms: options.intervalMs ?? previous?.interval_ms ?? DEFAULT_INTERVAL_MS,
    started_at: previous?.started_at ?? now,
    last_heartbeat_at: now,
    last_checked_at: now,
    last_result: lastResult,
    refresh_count: (previous?.refresh_count ?? 0) + (refreshed ? 1 : 0),
    last_refresh_at: refreshed ? now : previous?.last_refresh_at,
    last_error: lastError,
  };
  await saveWatchState(repoRoot, state);

  return {
    ok: true,
    refreshed,
    reason,
    source_before: before,
    source_after: after,
    watcher: state,
  };
}

export async function watchSourceIndex(
  repoRoot: string,
  options: RunSourceWatchOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  do {
    const iteration = await refreshSourceIndexIfNeeded(repoRoot, {
      ...options,
      intervalMs,
    });
    options.onEvent?.({ event: "watch_tick", ...iteration });
    if (options.signal?.aborted) return;
    await delay(intervalMs, options.signal);
  } while (!options.signal?.aborted);
}

function refreshReason(status: SourceIndexStatus): WatchRefreshReason {
  if (status.error) return "error";
  if (!status.indexed) return "missing";
  return status.fresh ? "fresh" : "stale";
}

async function loadWatchState(
  repoRoot: string,
): Promise<SourceWatchState | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(sourceWatchStatusPath(repoRoot), "utf8"),
    ) as SourceWatchState;
    return parsed.version === WATCH_STATE_VERSION ? parsed : null;
  } catch (err) {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || err instanceof SyntaxError) {
        return null;
      }
    }
    throw err;
  }
}

async function saveWatchState(
  repoRoot: string,
  state: SourceWatchState,
): Promise<void> {
  const statusPath = sourceWatchStatusPath(repoRoot);
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify(state, null, 2)}\n`);
}

function isWatchStateActive(
  state: SourceWatchState | null,
  options: SourceWatchOptions,
): boolean {
  if (!state) return false;
  const now = (options.now ?? (() => new Date()))().getTime();
  const heartbeat = Date.parse(state.last_heartbeat_at);
  if (!Number.isFinite(heartbeat)) return false;
  return now - heartbeat <= activeGraceMs(options);
}

function activeGraceMs(options: SourceWatchOptions): number {
  return Math.max(
    DEFAULT_ACTIVE_GRACE_MS,
    (options.intervalMs ?? DEFAULT_INTERVAL_MS) * 3,
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
