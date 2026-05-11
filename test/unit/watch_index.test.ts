import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { scanSourceIndex } from "../../src/source_index.js";
import {
  getSourceWatchStatus,
  refreshSourceIndexIfNeeded,
} from "../../src/watch_index.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-watch-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("source index watch freshness", () => {
  test("one-shot refresh rebuilds a stale source index without touching graph memory", async () => {
    await write("src/auth.ts", "export const AUTH_SCOPE = 'old';\n");
    await scanSourceIndex(tmpRoot);
    await write("src/auth.ts", "export const AUTH_SCOPE = 'new';\n");

    const result = await refreshSourceIndexIfNeeded(tmpRoot, {
      intervalMs: 250,
    });

    expect(result.ok).toBe(true);
    expect(result.refreshed).toBe(true);
    expect(result.reason).toBe("stale");
    expect(result.source_before.stale_files).toBe(1);
    expect(result.source_after.fresh).toBe(true);
    expect(result.watcher.last_result).toBe("refreshed");
    await expect(
      fs.stat(path.join(tmpRoot, ".codemap", "graph.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("status reports watcher metadata and source freshness without refreshing", async () => {
    await write("src/auth.ts", "export const AUTH_SCOPE = 'old';\n");
    await scanSourceIndex(tmpRoot);
    await write("src/new.ts", "export const NEW_SCOPE = true;\n");

    const status = await getSourceWatchStatus(tmpRoot);

    expect(status.ok).toBe(true);
    expect(status.source.new_files).toBe(1);
    expect(status.source.fresh).toBe(false);
    expect(status.watcher.state).toBeNull();
    expect(status.watcher.active).toBe(false);
    await expect(
      fs.stat(path.join(tmpRoot, ".codemap", "index", "watch.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("corrupt watch state is treated as rebuildable cache", async () => {
    await write("src/auth.ts", "export const AUTH_SCOPE = 'old';\n");
    await scanSourceIndex(tmpRoot);
    await fs.writeFile(
      path.join(tmpRoot, ".codemap", "index", "watch.json"),
      "{",
    );

    const result = await refreshSourceIndexIfNeeded(tmpRoot, {
      intervalMs: 250,
    });

    expect(result.ok).toBe(true);
    expect(result.watcher.last_result).toBe("fresh");

    const status = await getSourceWatchStatus(tmpRoot);
    expect(status.watcher.state?.last_result).toBe("fresh");
  });
});

async function write(filePath: string, content: string): Promise<void> {
  const absolutePath = path.join(tmpRoot, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}
