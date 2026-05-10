import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraphStore } from "../../src/graph.js";
import { inspectGraphRepair } from "../../src/graph_repair.js";
import { hashSourceRange } from "../../src/staleness.js";
import type { Node } from "../../src/types.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-graph-repair-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function write(filePath: string, content: string): Promise<void> {
  const absolutePath = path.join(tmpRoot, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

async function fileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(path.join(tmpRoot, filePath));
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function rangeHash(
  filePath: string,
  lineRange: readonly number[],
): Promise<string> {
  const content = await fs.readFile(path.join(tmpRoot, filePath));
  return hashSourceRange(content, lineRange);
}

function node(overrides: Partial<Node> & { id: string }): Node {
  const { id, ...rest } = overrides;
  return {
    id,
    kind: "invariant",
    name: id,
    summary: "test node",
    sources: [],
    tags: [],
    aliases: [],
    status: "active",
    confidence: 0.9,
    last_verified_at: "2026-05-10T00:00:00Z",
    ...rest,
  };
}

describe("graph repair", () => {
  test("proposes a hash refresh when a range-aware anchor stayed unchanged", async () => {
    await write(
      "src/x.ts",
      ["const preamble = 1;", "export const x = 1;", ""].join("\n"),
    );
    const originalFileHash = await fileHash("src/x.ts");
    const originalRangeHash = await rangeHash("src/x.ts", [2, 2]);
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(
      node({
        id: "x/range-fresh",
        sources: [
          {
            file_path: "src/x.ts",
            line_range: [2, 2],
            content_hash: originalFileHash,
            range_hash: originalRangeHash,
          },
        ],
      }),
    );
    await store.save();
    await write(
      "src/x.ts",
      ["const preamble = 2;", "export const x = 1;", ""].join("\n"),
    );

    const repair = await inspectGraphRepair(tmpRoot);

    expect(repair.ok).toBe(true);
    if (!repair.ok) throw new Error("expected ok");
    expect(repair.summary.proposals).toBe(1);
    expect(repair.summary.range_refreshes).toBe(1);
    expect(repair.proposals[0]).toEqual(
      expect.objectContaining({
        node_id: "x/range-fresh",
        action: "refresh_range_anchor",
        reason: "range_unchanged",
        legacy: false,
        replacement_source: {
          file_path: "src/x.ts",
          line_range: [2, 2],
          content_hash: await fileHash("src/x.ts"),
          range_hash: originalRangeHash,
        },
      }),
    );
  });

  test("marks changed full-file anchors as legacy re-anchoring proposals", async () => {
    await write("src/legacy.ts", "export const legacy = 1;\n");
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(
      node({
        id: "legacy/source",
        sources: [
          {
            file_path: "src/legacy.ts",
            line_range: [1, 1],
            content_hash: "sha256:old",
          },
        ],
      }),
    );
    await store.save();

    const repair = await inspectGraphRepair(tmpRoot);

    expect(repair.ok).toBe(true);
    if (!repair.ok) throw new Error("expected ok");
    expect(repair.summary.legacy_anchors).toBe(1);
    expect(repair.proposals[0]).toEqual(
      expect.objectContaining({
        node_id: "legacy/source",
        action: "reanchor_legacy_source",
        reason: "changed",
        legacy: true,
        replacement_source: {
          file_path: "src/legacy.ts",
          line_range: [1, 1],
          content_hash: await fileHash("src/legacy.ts"),
          range_hash: await rangeHash("src/legacy.ts", [1, 1]),
        },
      }),
    );
  });

  test("does not count unreachable legacy anchors as re-readable legacy anchors", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(
      node({
        id: "legacy/missing",
        sources: [
          {
            file_path: "src/missing.ts",
            line_range: [1, 1],
            content_hash: "sha256:old",
          },
        ],
      }),
    );
    await store.save();

    const repair = await inspectGraphRepair(tmpRoot);

    expect(repair.ok).toBe(true);
    if (!repair.ok) throw new Error("expected ok");
    expect(repair.summary.proposals).toBe(1);
    expect(repair.summary.legacy_anchors).toBe(0);
    expect(repair.summary.missing_sources).toBe(1);
    expect(repair.proposals[0]).toEqual(
      expect.objectContaining({
        node_id: "legacy/missing",
        action: "deprecate_or_reanchor",
        reason: "missing",
        legacy: true,
      }),
    );
    expect(repair.suggestions).not.toContain(
      "Legacy full-file anchors need re-reading before they can be upgraded to range-aware replacement_source anchors.",
    );
    expect(repair.suggestions).toContain(
      "Missing source files should usually lead to deprecation unless a replacement repo file is known.",
    );
  });
});
