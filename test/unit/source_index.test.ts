import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraphStore } from "../../src/graph.js";
import {
  clearSourceIndex,
  getSourceIndexStatus,
  loadSourceIndex,
  scanSourceIndex,
  searchSourceIndex,
} from "../../src/source_index.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-source-index-"));
  await write(
    "src/auth.ts",
    [
      "import { createClient } from './db';",
      "",
      "export interface SessionUser {",
      "  id: string;",
      "}",
      "",
      "export function requireActiveUser(token: string): SessionUser {",
      "  return { id: token };",
      "}",
    ].join("\n"),
  );
  await write(
    "src/payment.ts",
    [
      "export const createCheckoutSession = async (userId: string) => {",
      "  return { id: userId };",
      "};",
    ].join("\n"),
  );
  await write(
    "node_modules/ignored.ts",
    "export function ignored() {}",
  );
  await write("dist/generated.js", "export function generated() {}");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function write(filePath: string, content: string): Promise<void> {
  const absolutePath = path.join(tmpRoot, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

describe("source index", () => {
  test("scan builds a rebuildable index for supported source files", async () => {
    const index = await scanSourceIndex(tmpRoot);

    expect(index.stats.files_indexed).toBe(2);
    expect(index.stats.files_skipped).toBeGreaterThan(0);
    expect(index.files["src/auth.ts"]?.symbols.map((s) => s.name)).toEqual([
      "SessionUser",
      "requireActiveUser",
    ]);
    expect(index.files["src/payment.ts"]?.symbols.map((s) => s.name)).toEqual([
      "createCheckoutSession",
    ]);
    expect(index.files["node_modules/ignored.ts"]).toBeUndefined();
    expect(index.files["dist/generated.js"]).toBeUndefined();

    const reloaded = await loadSourceIndex(tmpRoot);
    expect(reloaded?.stats.chunks_indexed).toBe(4);
  });

  test("search ranks symbol and path matches above unrelated chunks", async () => {
    await scanSourceIndex(tmpRoot);

    const response = await searchSourceIndex(tmpRoot, "active user auth", {
      limit: 2,
    });

    expect(response.ok).toBe(true);
    expect(response.results[0]?.file_path).toBe("src/auth.ts");
    expect(response.results[0]?.symbols.map((s) => s.name)).toContain(
      "requireActiveUser",
    );
  });

  test("search total_results reports matches beyond the returned limit", async () => {
    await write("src/needle-a.ts", "export function sharedNeedleAlpha() {}");
    await write("src/needle-b.ts", "export function sharedNeedleBeta() {}");
    await write("src/needle-c.ts", "export function sharedNeedleGamma() {}");

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "shared needle", {
      limit: 2,
    });

    expect(response.results).toHaveLength(2);
    expect(response.total_results).toBe(3);
  });

  test("scan reports files skipped by source-index filters", async () => {
    await write("src/readme.md", "not a supported source extension");
    await write("src/client.generated.ts", "export function generated() {}");
    await write("src/huge.ts", "x".repeat(257 * 1024));

    const index = await scanSourceIndex(tmpRoot);

    expect(index.files["src/readme.md"]).toBeUndefined();
    expect(index.files["src/client.generated.ts"]).toBeUndefined();
    expect(index.files["src/huge.ts"]).toBeUndefined();
    expect(index.stats.files_skipped).toBeGreaterThanOrEqual(3);
  });

  test("search returns related graph nodes for matching source files", async () => {
    await scanSourceIndex(tmpRoot);
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode({
      id: "auth/session-user",
      kind: "invariant",
      name: "Session user invariant",
      summary: "requireActiveUser returns an active session user.",
      sources: [
        {
          file_path: "src/auth.ts",
          line_range: [7, 9],
          content_hash: "sha256:placeholder",
        },
      ],
      tags: ["auth"],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: "2026-04-28T00:00:00Z",
    });
    await store.save();

    const response = await searchSourceIndex(tmpRoot, "session user", {
      limit: 1,
    });

    expect(response.results[0]?.related_nodes[0]?.id).toBe("auth/session-user");
  });

  test("scan keeps preamble content before the first detected symbol searchable", async () => {
    await write(
      "src/preamble.ts",
      [
        "/**",
        " * Handshake sentinel lives before the first exported function.",
        " */",
        "const SCHEMA_VERSION = 1;",
        "",
        "export function afterPreamble() {",
        "  return SCHEMA_VERSION;",
        "}",
      ].join("\n"),
    );

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "handshake sentinel", {
      limit: 1,
    });

    expect(response.results[0]?.file_path).toBe("src/preamble.ts");
    expect(response.results[0]?.chunk_type).toBe("mixed");
    expect(response.results[0]?.content).toContain("SCHEMA_VERSION");
  });

  test("status reports fresh, stale, missing, and new files", async () => {
    await scanSourceIndex(tmpRoot);
    expect((await getSourceIndexStatus(tmpRoot)).fresh).toBe(true);

    await write("src/auth.ts", "export function changedAuth() {}");
    await write("src/new.ts", "export function newThing() {}");
    await fs.rm(path.join(tmpRoot, "src/payment.ts"));

    const status = await getSourceIndexStatus(tmpRoot);
    expect(status.stale_files).toBe(1);
    expect(status.missing_files).toBe(1);
    expect(status.new_files).toBe(1);
    expect(status.fresh).toBe(false);
  });

  test("status uses the max file size recorded during scan", async () => {
    await write(
      "src/large.ts",
      `export function largeSource() {}\n${"x".repeat(300 * 1024)}`,
    );

    const index = await scanSourceIndex(tmpRoot, {
      maxFileBytes: 512 * 1024,
    });
    expect(index.max_file_bytes).toBe(512 * 1024);
    expect(index.files["src/large.ts"]).toBeDefined();

    const status = await getSourceIndexStatus(tmpRoot);
    expect(status.missing_files).toBe(0);
    expect(status.fresh).toBe(true);
  });

  test("clear removes the source index cache", async () => {
    await scanSourceIndex(tmpRoot);
    expect(await loadSourceIndex(tmpRoot)).not.toBeNull();

    await clearSourceIndex(tmpRoot);
    expect(await loadSourceIndex(tmpRoot)).toBeNull();
  });
});
