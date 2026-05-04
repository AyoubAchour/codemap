import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraphStore } from "../../src/graph.js";
import { inspectGraphHealth } from "../../src/graph_health.js";
import type { Node } from "../../src/types.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-graph-health-"));
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
    last_verified_at: "2026-05-04T00:00:00Z",
    ...rest,
  };
}

describe("graph health", () => {
  test("reports a clean active graph as fresh", async () => {
    await write("src/x.ts", "export const x = 1;\n");
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(
      node({
        id: "x/invariant",
        sources: [
          {
            file_path: "src/x.ts",
            line_range: [1, 1],
            content_hash: await fileHash("src/x.ts"),
          },
        ],
      }),
    );
    await store.save();

    const health = await inspectGraphHealth(tmpRoot);

    expect(health.ok).toBe(true);
    if (!health.ok) throw new Error("expected ok");
    expect(health.summary.fresh).toBe(true);
    expect(health.summary.checked_sources).toBe(1);
    expect(health.suggestions).toEqual(["Graph health is clean."]);
  });

  test("groups duplicate aliases and stale source anchors", async () => {
    await write("src/x.ts", "export const x = 1;\n");
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(
      node({
        id: "x/one",
        aliases: ["same-alias"],
        sources: [
          {
            file_path: "src/x.ts",
            line_range: [1, 1],
            content_hash: "sha256:old",
          },
        ],
      }),
    );
    store.upsertNode(
      node({
        id: "x/two",
        aliases: ["same-alias"],
        sources: [
          {
            file_path: "src/missing.ts",
            line_range: [1, 1],
            content_hash: "sha256:missing",
          },
        ],
      }),
    );
    await store.save();

    const health = await inspectGraphHealth(tmpRoot);

    expect(health.ok).toBe(true);
    if (!health.ok) throw new Error("expected ok");
    expect(health.summary.fresh).toBe(false);
    expect(health.summary.duplicate_aliases).toBe(1);
    expect(health.summary.changed_sources).toBe(1);
    expect(health.summary.missing_sources).toBe(1);
    expect(health.issues.duplicate_aliases[0]?.alias).toBe("same-alias");
    expect(health.suggestions.join(" ")).toContain("duplicate aliases");
  });

  test("uses one stale-source reporting budget across categorized issue arrays", async () => {
    await write("src/x.ts", "export const x = 1;\n");
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(
      node({
        id: "x/changed",
        sources: [
          {
            file_path: "src/x.ts",
            line_range: [1, 1],
            content_hash: "sha256:old",
          },
        ],
      }),
    );
    store.upsertNode(
      node({
        id: "x/missing",
        sources: [
          {
            file_path: "src/missing.ts",
            line_range: [1, 1],
            content_hash: "sha256:missing",
          },
        ],
      }),
    );
    await store.save();

    const health = await inspectGraphHealth(tmpRoot, { issueLimit: 1 });

    expect(health.ok).toBe(true);
    if (!health.ok) throw new Error("expected ok");
    expect(health.summary.stale_sources).toBe(2);
    expect(health.staleness.stale_sources).toHaveLength(2);
    expect(health.summary.reported_stale_sources).toBe(1);
    expect(health.issues.stale_sources).toHaveLength(1);
    expect(
      health.issues.changed_sources.length +
        health.issues.missing_sources.length +
        health.issues.unsafe_sources.length +
        health.issues.read_errors.length,
    ).toBe(health.issues.stale_sources.length);
    expect([
      ...health.issues.changed_sources,
      ...health.issues.missing_sources,
      ...health.issues.unsafe_sources,
      ...health.issues.read_errors,
    ]).toEqual(health.issues.stale_sources);
  });

  test("skips deprecated nodes by default and includes them on request", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(
      node({
        id: "old/deprecated",
        status: "deprecated",
        sources: [
          {
            file_path: "src/removed.ts",
            line_range: [1, 1],
            content_hash: "sha256:removed",
          },
        ],
      }),
    );
    await store.save();

    const defaultHealth = await inspectGraphHealth(tmpRoot);
    const allHealth = await inspectGraphHealth(tmpRoot, {
      includeDeprecated: true,
    });

    expect(defaultHealth.ok).toBe(true);
    expect(allHealth.ok).toBe(true);
    if (!defaultHealth.ok || !allHealth.ok) throw new Error("expected ok");
    expect(defaultHealth.summary.checked_sources).toBe(0);
    expect(defaultHealth.summary.fresh).toBe(true);
    expect(allHealth.summary.checked_sources).toBe(1);
    expect(allHealth.summary.missing_sources).toBe(1);
  });
});
