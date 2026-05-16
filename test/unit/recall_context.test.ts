import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraphStore } from "../../src/graph.js";
import { buildRecallContext } from "../../src/recall_context.js";
import { scanSourceIndex } from "../../src/source_index.js";
import { hashBuffer, hashSourceRange } from "../../src/staleness.js";
import type { Node } from "../../src/types.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-recall-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeRepoFile(relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(tmpRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

async function seedGraphNode(
  overrides: Partial<Node> & { id: string; summary: string },
): Promise<void> {
  const store = await GraphStore.load(tmpRoot);
  store.upsertNode({
    kind: "invariant",
    name: overrides.id,
    sources: [],
    tags: [],
    aliases: [],
    status: "active",
    confidence: 0.9,
    last_verified_at: "2026-05-16T00:00:00Z",
    ...overrides,
  });
  await store.save();
}

async function seedRecallFixture(): Promise<void> {
  const source = [
    "export function requireActiveUser(session: { userId?: string }) {",
    "  if (!session.userId) {",
    "    throw new Error('active user required');",
    "  }",
    "  return { id: session.userId };",
    "}",
  ].join("\n");
  await writeRepoFile("src/auth.ts", source);
  await scanSourceIndex(tmpRoot);
  await seedGraphNode({
    id: "auth/require-active-user",
    kind: "invariant",
    name: "Active user guard",
    summary:
      "Route handlers must call requireActiveUser before returning private account data.",
    aliases: ["require active user", "auth guard"],
    tags: ["auth", "recall"],
    sources: [
      {
        file_path: "src/auth.ts",
        line_range: [1, 6],
        content_hash: hashBuffer(Buffer.from(source)),
        range_hash: hashSourceRange(source, [1, 6]),
      },
    ],
    quality: {
      utility_score: 0.9,
      maturity: "confirmed",
      confirmed_by_source: true,
    },
  });
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

describe("buildRecallContext", () => {
  test("returns compact graph and source recall within the configured byte budget", async () => {
    await seedRecallFixture();

    const result = await buildRecallContext(tmpRoot, "require active user", {
      budgetBytes: 2600,
      limit: 4,
      refreshIndex: "if_missing",
    });

    expect(result.ok).toBe(true);
    expect(result.budget.budget_bytes).toBe(2600);
    expect(result.budget.used_bytes).toBeLessThanOrEqual(2600);
    expect(responseBytes(result)).toBeLessThanOrEqual(2600);
    expect(result.budget.within_budget).toBe(true);
    expect(result.results.map((entry) => entry.provenance)).toContain(
      "curated_graph",
    );
    expect(result.results.map((entry) => entry.provenance)).toContain(
      "rebuildable_source_index",
    );
    expect(result.warnings).toContain(
      "Graph results are curated repo memory; source results are rebuildable index hits and must be inspected before writeback.",
    );

    const graphHit = result.results.find((entry) => entry.kind === "graph");
    expect(graphHit?.id).toBe("auth/require-active-user");
    expect(graphHit?.trust).toBeDefined();
    expect(graphHit?.freshness).toBeDefined();
    expect(graphHit?.anchors[0]).toEqual({
      file_path: "src/auth.ts",
      line_range: [1, 6],
    });

    const sourceHit = result.results.find((entry) => entry.kind === "source");
    expect(sourceHit?.file_path).toBe("src/auth.ts");
    expect(sourceHit?.anchors[0]).toEqual({
      file_path: "src/auth.ts",
      line_range: [1, 6],
    });
  });

  test("omits lower ranked candidates instead of exceeding a tight byte budget", async () => {
    await seedRecallFixture();

    const result = await buildRecallContext(tmpRoot, "require active user", {
      budgetBytes: 900,
      limit: 4,
      refreshIndex: "if_missing",
    });

    expect(result.ok).toBe(true);
    expect(responseBytes(result)).toBeLessThanOrEqual(900);
    expect(result.budget.within_budget).toBe(true);
    expect(result.budget.truncated).toBe(true);
    expect(
      result.budget.omitted.graph + result.budget.omitted.source,
    ).toBeGreaterThan(0);
    expect(result.warnings).toContain(
      "Recall results were omitted to stay within the configured byte budget.",
    );
  });

  test("reports stale graph recall anchors explicitly", async () => {
    await seedRecallFixture();
    await writeRepoFile(
      "src/auth.ts",
      "export function requireActiveUser() { return { id: 'changed' }; }\n",
    );

    const result = await buildRecallContext(tmpRoot, "require active user", {
      mode: "graph",
      budgetBytes: 1800,
      limit: 2,
      refreshIndex: "never",
    });

    expect(result.results[0]).toEqual(
      expect.objectContaining({
        kind: "graph",
        freshness: "stale",
      }),
    );
    expect(result.warnings).toContain(
      "Some graph recall anchors are stale; inspect source files before relying on them.",
    );
  });

  test("reports empty recall explicitly", async () => {
    const result = await buildRecallContext(tmpRoot, "nothing matches this", {
      budgetBytes: 1400,
      limit: 3,
      refreshIndex: "never",
    });

    expect(result.ok).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.budget.omitted).toEqual({ graph: 0, source: 0 });
    expect(result.warnings).toContain(
      "No recall hits were found in graph memory or the source index.",
    );
    expect(result.warnings).toContain(
      "Source index is missing; run codemap scan or use refresh_index if_missing before relying on source recall.",
    );
  });
});
