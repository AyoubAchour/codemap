import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraphStore } from "../../src/graph.js";
import { buildQueryContext } from "../../src/query_context.js";
import { scanSourceIndex } from "../../src/source_index.js";
import { hashBuffer, hashSourceRange } from "../../src/staleness.js";
import type { Node } from "../../src/types.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-query-context-"));
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
    kind: "decision",
    name: overrides.id,
    sources: [],
    tags: [],
    aliases: [],
    status: "active",
    confidence: 0.9,
    last_verified_at: "2026-05-27T00:00:00Z",
    ...overrides,
  });
  await store.save();
}

async function seedQueryContextFixture(): Promise<void> {
  const source = [
    "export interface SessionUser { id: string }",
    "export function requireActiveUser(token: string): SessionUser {",
    "  const auditTrail = [",
    ...Array.from(
      { length: 140 },
      (_value, index) =>
        `    "auth audit marker ${index} requireActiveUser active user planning context budget",`,
    ),
    "  ];",
    "  return { id: auditTrail.includes(token) ? token : token };",
    "}",
  ].join("\n");
  await writeRepoFile("src/auth.ts", source);
  await scanSourceIndex(tmpRoot);
  await seedGraphNode({
    id: "auth/active-user-planning",
    name: "Active user planning context",
    summary:
      "Planning context for auth work should preserve the active user guard and source expansion hints.",
    aliases: ["requireActiveUser", "active user"],
    tags: ["auth", "query-context"],
    sources: [
      {
        file_path: "src/auth.ts",
        line_range: [1, 148],
        content_hash: hashBuffer(Buffer.from(source)),
        range_hash: hashSourceRange(source, [1, 148]),
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

describe("buildQueryContext", () => {
  test("preserves the existing unbudgeted planning shape by default", async () => {
    await seedQueryContextFixture();

    const result = await buildQueryContext(
      tmpRoot,
      "requireActiveUser active user planning context",
      {
        sourceLimit: 1,
        maxContentChars: 3000,
        dependencyLimit: 1,
        includeImpact: true,
      },
    );

    expect(result.ok).toBe(true);
    expect("budget" in result).toBe(false);
    expect(result.source.search?.ok).toBe(true);
    expect(result.source.search?.results[0]?.content).toContain(
      "auth audit marker",
    );
  });

  test("fits explicit budget by trimming bulky planning detail before source hits", async () => {
    await seedQueryContextFixture();

    const unbudgeted = await buildQueryContext(
      tmpRoot,
      "requireActiveUser active user planning context",
      {
        sourceLimit: 1,
        maxContentChars: 3000,
        dependencyLimit: 1,
        includeImpact: true,
      },
    );
    const budgetBytes = Math.max(5000, responseBytes(unbudgeted) - 1800);

    const result = await buildQueryContext(
      tmpRoot,
      "requireActiveUser active user planning context",
      {
        sourceLimit: 1,
        maxContentChars: 3000,
        dependencyLimit: 1,
        includeImpact: true,
        budgetBytes,
      },
    );
    const unbudgetedContentLength =
      unbudgeted.source.search?.results[0]?.content.length ?? 0;

    expect(result.budget).toBeDefined();
    expect(result.budget?.budget_bytes).toBe(budgetBytes);
    expect(result.budget?.used_bytes).toBeLessThanOrEqual(budgetBytes);
    expect(result.budget?.within_budget).toBe(true);
    expect(result.budget?.truncated).toBe(true);
    expect(responseBytes(result)).toBeLessThanOrEqual(budgetBytes);
    expect(result.source.search?.results[0]?.file_path).toBe("src/auth.ts");
    expect(unbudgetedContentLength).toBeGreaterThan(0);
    expect(result.source.search?.results[0]?.content.length).toBeLessThan(
      unbudgetedContentLength,
    );
    expect(result.expansion.source_files[0]).toEqual(
      expect.objectContaining({
        file_path: "src/auth.ts",
        action: "inspect_file",
      }),
    );
    expect(result.budget?.packing.lanes.source?.selected).toBe(1);
    expect(
      result.budget?.packing.lanes.source?.omitted_by_budget,
    ).toBeGreaterThan(0);
    expect(result.warnings).toContain(
      "Query context was trimmed to stay within the configured byte budget.",
    );
  });

  test("fits explicit budget by trimming oversized graph memory payloads", async () => {
    const hugeSummary = Array.from(
      { length: 520 },
      (_value, index) =>
        `oversized graph budget marker ${index} planning memory payload`,
    ).join(" ");
    await seedGraphNode({
      id: "budget/oversized-graph-memory",
      name: "Oversized graph budget memory",
      summary: hugeSummary,
      aliases: ["oversized graph budget"],
      tags: ["budgeting", "query-context"],
    });

    const result = await buildQueryContext(
      tmpRoot,
      "oversized graph budget planning memory",
      {
        graphLimit: 1,
        sourceLimit: 0,
        refreshIndex: "never",
        budgetBytes: 6500,
      },
    );

    expect(result.budget?.budget_bytes).toBe(6500);
    expect(result.budget?.used_bytes).toBeLessThanOrEqual(6500);
    expect(result.budget?.within_budget).toBe(true);
    expect(responseBytes(result)).toBeLessThanOrEqual(6500);
    expect(result.graph.nodes[0]?.id).toBe("budget/oversized-graph-memory");
    expect(result.graph.nodes[0]?.summary.length).toBeLessThan(
      hugeSummary.length,
    );
    expect(
      result.budget?.packing.lanes.graph?.omitted_by_budget,
    ).toBeGreaterThan(0);
  });

  test("recomputes graph quality after budget trims graph source anchors", async () => {
    const missingSources = Array.from({ length: 80 }, (_value, index) => ({
      file_path: `src/missing-anchor-${index}.ts`,
      line_range: [1, 1] as [number, number],
      content_hash: `sha256:${index.toString(16).padStart(64, "0")}`,
    }));
    await seedGraphNode({
      id: "budget/source-trim-quality",
      name: "Source trim quality metadata",
      summary: "Budget trimming must recompute quality after source anchors are removed.",
      aliases: ["source trim quality"],
      tags: ["budgeting", "quality"],
      sources: missingSources,
    });

    const result = await buildQueryContext(
      tmpRoot,
      "source trim quality metadata budget",
      {
        graphLimit: 1,
        sourceLimit: 0,
        refreshIndex: "never",
        budgetBytes: 4250,
      },
    );

    const node = result.graph.nodes[0];
    const match = result.graph.matches.find(
      (entry) => entry.node_id === node?.id,
    );
    const summary = result.summary.graph_memories.find(
      (entry) => entry.id === node?.id,
    );

    expect(node?.id).toBe("budget/source-trim-quality");
    expect(node?.sources).toHaveLength(0);
    expect(result.budget?.within_budget).toBe(true);
    expect(result.graph.staleness.checked_sources).toBe(0);
    expect(result.graph.staleness.stale_sources).toHaveLength(0);
    expect(match?.quality?.checked_sources).toBe(0);
    expect(match?.quality?.stale_sources).toBe(0);
    expect(match?.quality?.freshness).toBe("no_sources");
    expect(summary?.freshness).toBe("no_sources");
    expect(summary?.quality_reasons).toContain("no source anchors to verify");
    expect(result.warnings.join("\n")).not.toContain("stale source anchors");
    expect(result.warnings.join("\n")).not.toContain("low-trust");
  });

  test("preserves checked source counts for retained fresh graph anchors", async () => {
    const sources = [];
    for (let index = 0; index < 40; index += 1) {
      const filePath = `src/fresh-anchor-${index}.ts`;
      const source = `export const freshAnchor${index} = "fresh source budget marker ${index}";\n`;
      await writeRepoFile(filePath, source);
      sources.push({
        file_path: filePath,
        line_range: [1, 1] as [number, number],
        content_hash: hashBuffer(Buffer.from(source)),
        range_hash: hashSourceRange(source, [1, 1]),
      });
    }
    await seedGraphNode({
      id: "budget/fresh-source-count",
      name: "Fresh source count budget metadata",
      summary: "Budget trimming must preserve checked source counts for fresh anchors.",
      aliases: ["fresh source count"],
      tags: ["budgeting", "quality"],
      sources,
    });

    const result = await buildQueryContext(
      tmpRoot,
      "fresh source count budget metadata",
      {
        graphLimit: 1,
        sourceLimit: 0,
        refreshIndex: "never",
        budgetBytes: 4500,
      },
    );

    const node = result.graph.nodes[0];
    const retainedSourceCount = node?.sources.length ?? 0;
    const match = result.graph.matches.find(
      (entry) => entry.node_id === node?.id,
    );

    expect(node?.id).toBe("budget/fresh-source-count");
    expect(retainedSourceCount).toBeGreaterThan(0);
    expect(retainedSourceCount).toBeLessThan(sources.length);
    expect(result.graph.staleness.stale_sources).toHaveLength(0);
    expect(result.graph.staleness.range_fresh_sources).toHaveLength(0);
    expect(result.graph.staleness.checked_sources).toBe(retainedSourceCount);
    expect(match?.quality?.checked_sources).toBe(retainedSourceCount);
    expect(match?.quality?.freshness).toBe("fresh");
  });
});
