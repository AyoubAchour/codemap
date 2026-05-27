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
});
