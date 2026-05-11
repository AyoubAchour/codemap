import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraphStore } from "../../src/graph.js";
import { runRetrievalBenchmark } from "../../src/retrieval_benchmark.js";
import { scanSourceIndex } from "../../src/source_index.js";
import { hashBuffer } from "../../src/staleness.js";
import type { Node } from "../../src/types.js";

let tmpRoot: string;
const repoRoot = path.resolve(import.meta.dir, "../..");

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-retrieval-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("retrieval benchmark", () => {
  test("bundled Codemap suite covers harder retrieval scenarios", async () => {
    const suite = JSON.parse(
      await fs.readFile(
        path.join(repoRoot, "benchmarks", "retrieval.codemap.json"),
        "utf8",
      ),
    ) as {
      queries: Array<{
        id: string;
        expected_files?: string[];
        tags?: string[];
      }>;
    };
    const tags = new Set(suite.queries.flatMap((query) => query.tags ?? []));
    const ids = new Set(suite.queries.map((query) => query.id));

    expect(suite.queries.length).toBeGreaterThanOrEqual(12);
    expect([...tags].sort()).toEqual(
      expect.arrayContaining([
        "semantic",
        "typo",
        "impact",
        "renamed-symbol",
        "stale-graph",
        "docs",
        "tests",
      ]),
    );
    expect([...ids].sort()).toEqual(
      expect.arrayContaining([
        "semantic-agent-onboarding",
        "typo-source-index",
        "renamed-reexport-ast",
        "docs-task-055",
        "tests-retrieval-benchmark",
      ]),
    );
    expect(
      suite.queries.some((query) =>
        (query.expected_files ?? []).some((filePath) =>
          filePath.startsWith("tasks/"),
        ),
      ),
    ).toBe(true);
    expect(
      suite.queries.some((query) =>
        (query.expected_files ?? []).some((filePath) =>
          filePath.startsWith("test/"),
        ),
      ),
    ).toBe(true);
  });

  test("runs a non-Codemap fixture repo retrieval suite", async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.cp(
      path.join(repoRoot, "benchmarks", "fixtures", "taskflow-app"),
      tmpRoot,
      { recursive: true },
    );
    await scanSourceIndex(tmpRoot);

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "benchmarks/retrieval.fixture.json",
      limit: 5,
      maxContentChars: 200,
      dependencyLimit: 1,
      includeImpact: true,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.query_count).toBeGreaterThanOrEqual(6);
    expect(response.summary.files.hit_rate_at_k).toBe(1);
    expect(response.summary.files.recall_at_k).toBeGreaterThanOrEqual(0.75);
    expect(response.summary.average_source_file_diversity).toBeGreaterThan(0);
    expect(
      [...new Set(response.results.flatMap((result) => result.tags))].sort(),
    ).toEqual(expect.arrayContaining(["semantic", "typo", "docs", "tests"]));
  });

  test("runs a local suite and reports file/node retrieval metrics", async () => {
    const authSource = [
      "export function requireActiveUser(token: string) {",
      "  return { id: token };",
      "}",
      "",
    ].join("\n");
    await write("src/auth.ts", authSource);
    await write(
      "src/payment.ts",
      "export function createCheckoutSession(userId: string) { return userId; }\n",
    );
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "test retrieval suite",
          queries: [
            {
              id: "auth-memory",
              query: "active user auth invariant",
              expected_files: ["src/auth.ts"],
              expected_nodes: ["auth/active-user"],
            },
            {
              id: "checkout-source",
              query: "create checkout session payment",
              expected_files: ["src/payment.ts"],
            },
          ],
        },
        null,
        2,
      ),
    );
    await scanSourceIndex(tmpRoot);
    await seed([
      makeNode({
        id: "auth/active-user",
        name: "Active user auth invariant",
        summary: "requireActiveUser returns the authenticated session actor.",
        sources: [
          {
            file_path: "src/auth.ts",
            line_range: [1, 3],
            content_hash: hashBuffer(Buffer.from(authSource)),
          },
        ],
      }),
    ]);

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 3,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.query_count).toBe(2);
    expect(response.summary.files.evaluated_queries).toBe(2);
    expect(response.summary.files.hit_rate_at_k).toBe(1);
    expect(response.summary.nodes.evaluated_queries).toBe(1);
    expect(response.summary.nodes.hit_rate_at_k).toBe(1);
    expect(response.summary.average_response_bytes).toBeGreaterThan(0);
    expect(response.summary.experimental).toEqual(
      expect.objectContaining({
        embeddings: "disabled",
        reranking: "disabled",
      }),
    );
    expect(response.results[0]?.files.returned).toContain("src/auth.ts");
    expect(response.results[0]?.nodes.returned).toContain("auth/active-user");
  });

  test("calculates precision against actual returned targets", async () => {
    await write(
      "src/auth.ts",
      "export function requireActiveUser(token: string) { return token; }\n",
    );
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "sparse precision suite",
          queries: [
            {
              id: "auth-source",
              query: "require active user token",
              expected_files: ["src/auth.ts"],
            },
          ],
        },
        null,
        2,
      ),
    );
    await scanSourceIndex(tmpRoot);

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 10,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.results[0]?.files.returned).toEqual(["src/auth.ts"]);
    expect(response.results[0]?.files.precision_at_k).toBe(1);
  });

  test("refreshes a stale source index by default", async () => {
    await write("src/old.ts", "export const OLD_MARKER = true;\n");
    await scanSourceIndex(tmpRoot);
    await write("docs/runbook.md", "fresh benchmark runbook marker\n");
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "fresh benchmark suite",
          queries: [
            {
              id: "fresh-doc",
              query: "fresh benchmark runbook marker",
              expected_files: ["docs/runbook.md"],
            },
          ],
        },
        null,
        2,
      ),
    );

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 3,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.source.fresh).toBe(true);
    expect(response.results[0]?.files.returned).toContain("docs/runbook.md");
    expect(response.summary.files.hit_rate_at_k).toBe(1);
  });

  test("accepts node-only expectations", async () => {
    const authSource = "export const AUTH_SCOPE = 'active';\n";
    await write("src/auth.ts", authSource);
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "node-only suite",
          queries: [
            {
              id: "auth-memory",
              query: "active user auth invariant",
              expected_nodes: ["auth/active-user"],
            },
          ],
        },
        null,
        2,
      ),
    );
    await scanSourceIndex(tmpRoot);
    await seed([
      makeNode({
        id: "auth/active-user",
        name: "Active user auth invariant",
        summary: "AUTH_SCOPE documents active user behavior.",
        sources: [
          {
            file_path: "src/auth.ts",
            line_range: [1, 1],
            content_hash: hashBuffer(Buffer.from(authSource)),
          },
        ],
      }),
    ]);

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 3,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.files.evaluated_queries).toBe(0);
    expect(response.summary.nodes.hit_rate_at_k).toBe(1);
  });

  test("reports threshold failures without changing benchmark data", async () => {
    await write("src/auth.ts", "export const AUTH_SCOPE = 'active';\n");
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "test retrieval suite",
          queries: [
            {
              id: "miss",
              query: "unrelated billing invoice",
              expected_files: ["src/auth.ts"],
            },
          ],
        },
        null,
        2,
      ),
    );
    await scanSourceIndex(tmpRoot);

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 1,
      minFileHitRate: 1,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.thresholds.passed).toBe(false);
    expect(response.summary.thresholds.failed).toEqual(["files.hit_rate_at_k"]);
  });

  test("reports node threshold failures", async () => {
    await write("src/auth.ts", "export const AUTH_SCOPE = 'active';\n");
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "node threshold suite",
          queries: [
            {
              id: "missing-node",
              query: "missing graph memory",
              expected_nodes: ["auth/missing"],
            },
          ],
        },
        null,
        2,
      ),
    );
    await scanSourceIndex(tmpRoot);

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 1,
      minNodeHitRate: 1,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.thresholds.passed).toBe(false);
    expect(response.summary.thresholds.failed).toEqual(["nodes.hit_rate_at_k"]);
  });

  test("rejects suites without expected files or nodes", async () => {
    await write(
      "retrieval-suite.json",
      JSON.stringify({
        version: 1,
        name: "invalid suite",
        queries: [{ id: "empty", query: "anything" }],
      }),
    );

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
    });

    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("expected invalid suite");
    expect(response.error.code).toBe("SUITE_INVALID");
  });
});

async function write(filePath: string, content: string): Promise<void> {
  const absolutePath = path.join(tmpRoot, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

async function seed(nodes: Node[]): Promise<void> {
  const store = await GraphStore.load(tmpRoot);
  for (const node of nodes) store.upsertNode(node);
  await store.save();
}

function makeNode(overrides: Partial<Node> & { id: string }): Node {
  return {
    kind: "invariant",
    name: overrides.id,
    summary: "test summary",
    sources: [],
    tags: [],
    aliases: [],
    status: "active",
    confidence: 0.95,
    last_verified_at: "2026-05-10T12:00:00Z",
    ...overrides,
  };
}
