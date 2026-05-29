import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraphStore } from "../../src/graph.js";
import { runRetrievalBenchmark } from "../../src/retrieval_benchmark.js";
import type {
  SemanticRerankAdapter,
  SemanticRetrievalAdapter,
} from "../../src/semantic_retrieval.js";
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
        supporting_files?: string[];
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
        "guardrail",
        "provenance",
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
    expect(
      suite.queries.some((query) => (query.supporting_files ?? []).length > 0),
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

  test("taskflow fixture keeps distractors out of compact recall guardrails", async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.cp(
      path.join(repoRoot, "benchmarks", "fixtures", "taskflow-app"),
      tmpRoot,
      { recursive: true },
    );

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "benchmarks/retrieval.fixture.json",
      profile: "recall",
      refreshIndex: "if_stale",
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.files.hit_rate_at_k).toBe(1);
    expect(response.summary.files.recall_at_k).toBe(1);
    expect(response.summary.files.mrr).toBe(1);
    expect(response.summary.files.forbidden_violation_rate).toBe(0);
    expect(response.summary.files.false_positive_rate_at_k).toBe(0);
  });

  test("taskflow fixture keeps distractors out of planning guardrails", async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.cp(
      path.join(repoRoot, "benchmarks", "fixtures", "taskflow-app"),
      tmpRoot,
      { recursive: true },
    );

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "benchmarks/retrieval.fixture.json",
      refreshIndex: "if_stale",
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.files.hit_rate_at_k).toBe(1);
    expect(response.summary.files.recall_at_k).toBe(1);
    expect(response.summary.files.forbidden_violation_rate).toBe(0);
    expect(response.summary.files.false_positive_rate_at_k).toBe(0);
    expect(response.summary.audit.forbidden_file_hits).toEqual([]);
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
    expect(response.summary.experimental.semantic_retrieval).toEqual(
      expect.objectContaining({
        enabled: false,
        provider: "disabled",
        provider_kind: "none",
      }),
    );
    expect(response.results[0]?.semantic.files.evaluated).toBe(false);
    expect(response.results[0]?.files.returned).toContain("src/auth.ts");
    expect(response.results[0]?.nodes.returned).toContain("auth/active-user");
  });

  test("evaluates forbidden targets, warnings, and result sources", async () => {
    const authSource = [
      "export function requireActiveUser(token: string) {",
      "  return { id: token, scope: 'active' };",
      "}",
      "",
    ].join("\n");
    await write("src/auth.ts", authSource);
    await write(
      "src/noise.ts",
      "export function createInvoice() { return 'billing'; }\n",
    );
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "optimization guardrail suite",
          queries: [
            {
              id: "auth-guardrails",
              query: "active user auth invariant",
              expected_files: ["src/auth.ts"],
              expected_nodes: ["auth/active-user"],
              forbidden_files: ["src/noise.ts"],
              forbidden_nodes: ["billing/noise"],
              expected_warnings: ["Graph matches are curated repo memory"],
              expected_result_sources: ["graph", "source"],
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
        summary: "requireActiveUser returns an active authenticated actor.",
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
      limit: 5,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const result = response.results[0];
    expect(result?.files.clean).toBe(true);
    expect(result?.files.forbidden).toEqual(["src/noise.ts"]);
    expect(result?.files.forbidden_matched).toEqual([]);
    expect(result?.nodes.clean).toBe(true);
    expect(result?.warning_expectations.matched).toEqual([
      "Graph matches are curated repo memory",
    ]);
    expect(result?.warning_expectations.missing).toEqual([]);
    expect(result?.result_sources.matched.sort()).toEqual(["graph", "source"]);
    expect(response.summary.files.forbidden_evaluated_queries).toBe(1);
    expect(response.summary.files.forbidden_violation_rate).toBe(0);
    expect(response.summary.nodes.forbidden_evaluated_queries).toBe(1);
    expect(response.summary.warning_expectations.hit_rate_at_k).toBe(1);
    expect(response.summary.result_sources.recall_at_k).toBe(1);
  });

  test("surfaces forbidden result violations", async () => {
    const authSource = "export const AUTH_SCOPE = 'active';\n";
    await write("src/auth.ts", authSource);
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "forbidden violation suite",
          queries: [
            {
              id: "auth-violation",
              query: "active auth scope",
              expected_files: ["src/auth.ts"],
              expected_nodes: ["auth/active-user"],
              forbidden_files: ["src/auth.ts"],
              forbidden_nodes: ["auth/active-user"],
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
        name: "Active auth scope",
        summary: "AUTH_SCOPE is the active auth marker.",
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
    expect(response.results[0]?.files.clean).toBe(false);
    expect(response.results[0]?.files.forbidden_matched).toEqual([
      "src/auth.ts",
    ]);
    expect(response.results[0]?.nodes.clean).toBe(false);
    expect(response.results[0]?.nodes.forbidden_matched).toEqual([
      "auth/active-user",
    ]);
    expect(response.summary.files.forbidden_violation_rate).toBe(1);
    expect(response.summary.files.false_positive_rate_at_k).toBe(1);
    expect(response.summary.nodes.forbidden_violation_rate).toBe(1);
    expect(response.next_steps.join("\n")).toContain("forbidden file hits");
    expect(response.next_steps.join("\n")).toContain("forbidden graph hits");
  });

  test("accepts forbidden-only guardrail cases", async () => {
    await write("src/auth.ts", "export const AUTH_SCOPE = 'active';\n");
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "forbidden only suite",
          queries: [
            {
              id: "guardrail-only",
              query: "active auth scope",
              forbidden_files: ["src/noise.ts"],
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
      limit: 3,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.results[0]?.files.evaluated).toBe(false);
    expect(response.results[0]?.files.clean).toBe(true);
    expect(response.summary.files.evaluated_queries).toBe(0);
    expect(response.summary.files.forbidden_evaluated_queries).toBe(1);
    expect(response.summary.files.forbidden_violation_rate).toBe(0);
  });

  test("recall profile uses compact defaults without changing planning defaults", async () => {
    await write(
      "src/auth.ts",
      "export function requireActiveUser(token: string) { return token; }\n",
    );
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "recall profile suite",
          queries: [
            {
              id: "auth-recall",
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

    const planning = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
    });
    const recall = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      profile: "recall",
    });

    expect(planning.ok).toBe(true);
    expect(recall.ok).toBe(true);
    if (!planning.ok) throw new Error(planning.error.message);
    if (!recall.ok) throw new Error(recall.error.message);
    expect(planning.summary.profile).toBe("planning");
    expect(planning.summary.limit).toBe(10);
    expect(planning.summary.mode).toBe("standard");
    expect(recall.summary.profile).toBe("recall");
    expect(recall.summary.limit).toBe(5);
    expect(recall.summary.mode).toBe("compact");
    expect(recall.summary.average_response_bytes).toBeLessThanOrEqual(
      planning.summary.average_response_bytes,
    );
  });

  test("benchmarks an injected semantic file adapter independently from source hits", async () => {
    await write(
      "src/auth.ts",
      "export function requireActiveUser(token: string) { return token; }\n",
    );
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "semantic adapter suite",
          queries: [
            {
              id: "semantic-auth",
              query: "person access policy",
              expected_files: ["src/auth.ts"],
              expected_result_sources: ["semantic"],
            },
          ],
        },
        null,
        2,
      ),
    );
    await scanSourceIndex(tmpRoot);
    const adapter: SemanticRetrievalAdapter = {
      name: "test-local-embedder",
      kind: "local",
      async searchFiles(input) {
        expect(input.query).toBe("person access policy");
        expect(input.limit).toBe(5);
        return [
          {
            file_path: ".\\src\\auth.ts",
            score: 0.91,
            reason: "test semantic synonym match",
          },
        ];
      },
    };

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 5,
      semantic: { fileAdapter: adapter },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.experimental.embeddings).toBe("adapter");
    expect(response.summary.experimental.semantic_retrieval).toEqual(
      expect.objectContaining({
        enabled: true,
        provider: "test-local-embedder",
        provider_kind: "local",
        average_latency_ms: expect.any(Number),
      }),
    );
    expect(
      response.summary.experimental.semantic_retrieval.files.hit_rate_at_k,
    ).toBe(1);
    expect(response.results[0]?.semantic.files.returned).toEqual([
      "src/auth.ts",
    ]);
    expect(response.results[0]?.semantic.files.hit).toBe(true);
    expect(response.results[0]?.semantic.hits[0]).toEqual(
      expect.objectContaining({
        file_path: "src/auth.ts",
        score: 0.91,
        reason: "test semantic synonym match",
      }),
    );
    expect(response.results[0]?.result_sources.matched).toContain("semantic");
    expect(response.summary.result_sources.hit_rate_at_k).toBe(1);
  });

  test("benchmarks the built-in local hash semantic provider", async () => {
    await write(
      "src/source_index.ts",
      [
        "export function refreshSourceIndex() {",
        "  return 'search chunks symbols stale files freshness';",
        "}",
        "",
      ].join("\n"),
    );
    await write(
      "src/noise.ts",
      "export function invoiceWorkflow() { return 'billing checkout'; }\n",
    );
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "local hash semantic suite",
          queries: [
            {
              id: "typo-source-index",
              query: "sorce indx frshness seach chunks symbols stale files",
              expected_files: ["src/source_index.ts"],
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
      limit: 3,
      semantic: { provider: "local-hash" },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.experimental.embeddings).toBe("adapter");
    expect(response.summary.experimental.semantic_retrieval).toEqual(
      expect.objectContaining({
        enabled: true,
        provider: "local-hash",
        provider_kind: "local",
      }),
    );
    expect(
      response.summary.variants.local_vector_files.hit_rate_at_k,
    ).toBe(1);
    expect(response.results[0]?.semantic.hits[0]).toEqual(
      expect.objectContaining({
        file_path: "src/source_index.ts",
        reason: expect.stringContaining("local hash-vector similarity"),
      }),
    );
  });

  test("provider disabled prevents injected semantic and reranker adapters from running", async () => {
    await write(
      "src/auth.ts",
      "export function requireActiveUser(token: string) { return token; }\n",
    );
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "disabled provider suite",
          queries: [
            {
              id: "disabled-auth",
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
    let semanticCalled = false;
    let rerankerCalled = false;
    const semanticAdapter: SemanticRetrievalAdapter = {
      name: "should-not-run",
      kind: "local",
      async searchFiles() {
        semanticCalled = true;
        return [{ file_path: "src/auth.ts", score: 1 }];
      },
    };
    const reranker: SemanticRerankAdapter = {
      name: "should-not-rerank",
      kind: "local",
      async rerankFiles() {
        rerankerCalled = true;
        return [{ file_path: "src/auth.ts", score: 1 }];
      },
    };

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 5,
      semantic: { provider: "disabled", fileAdapter: semanticAdapter },
      reranker: { provider: "disabled", fileReranker: reranker },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(semanticCalled).toBe(false);
    expect(rerankerCalled).toBe(false);
    expect(response.summary.experimental.embeddings).toBe("disabled");
    expect(response.summary.experimental.reranking).toBe("disabled");
    expect(response.results[0]?.semantic.enabled).toBe(false);
    expect(response.results[0]?.reranker.enabled).toBe(false);
  });

  test("visibly reports cloud semantic adapters as opt-in", async () => {
    await write("src/auth.ts", "export const AUTH_SCOPE = 'active';\n");
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "cloud semantic adapter suite",
          queries: [
            {
              id: "semantic-auth",
              query: "active user",
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
      semantic: {
        fileAdapter: {
          name: "test-cloud-embedder",
          kind: "cloud",
          async searchFiles() {
            return [{ file_path: "src/auth.ts", score: 0.8 }];
          },
        },
      },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.experimental.semantic_retrieval.provider_kind).toBe(
      "cloud",
    );
    expect(response.warnings.join("\n")).toContain(
      "Cloud semantic retrieval provider test-cloud-embedder is opt-in",
    );
  });

  test("benchmarks an injected reranker against source-search candidates", async () => {
    await write(
      "src/auth.ts",
      "export function requireActiveUser(token: string) { return token; }\n",
    );
    await write(
      "src/noise.ts",
      "export function requireActiveInvoice(token: string) { return token; }\n",
    );
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "reranker adapter suite",
          queries: [
            {
              id: "rerank-auth",
              query: "require active user token",
              expected_files: ["src/auth.ts"],
              expected_result_sources: ["source", "reranker"],
            },
          ],
        },
        null,
        2,
      ),
    );
    await scanSourceIndex(tmpRoot);
    const reranker: SemanticRerankAdapter = {
      name: "test-local-reranker",
      kind: "local",
      async rerankFiles(input) {
        expect(input.candidates.map((candidate) => candidate.file_path)).toContain(
          "src/auth.ts",
        );
        return [{ file_path: "src/auth.ts", score: 0.99 }];
      },
    };

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 5,
      reranker: { fileReranker: reranker },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.experimental.reranking).toBe("adapter");
    expect(response.summary.experimental.reranker).toEqual(
      expect.objectContaining({
        enabled: true,
        provider: "test-local-reranker",
        provider_kind: "local",
      }),
    );
    expect(response.summary.experimental.reranker.files.hit_rate_at_k).toBe(1);
    expect(response.results[0]?.reranker.files.returned).toEqual([
      "src/auth.ts",
    ]);
    expect(response.results[0]?.result_sources.matched.sort()).toEqual([
      "reranker",
      "source",
    ]);
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

  test("reports payload budget compliance and threshold failures", async () => {
    await write(
      "src/auth.ts",
      [
        "export function requireActiveUser(token: string) {",
        "  return { id: token, scope: 'active' };",
        "}",
        "",
      ].join("\n"),
    );
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "payload budget suite",
          queries: [
            {
              id: "auth-budget",
              query: "require active user token scope",
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
      limit: 3,
      responseBudgetBytes: 10,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.results[0]?.payload.response_budget_bytes).toBe(10);
    expect(response.results[0]?.payload.within_budget).toBe(false);
    expect(response.results[0]?.payload.over_budget_bytes).toBeGreaterThan(0);
    expect(response.summary.payload_budget.evaluated_queries).toBe(1);
    expect(response.summary.payload_budget.compliance_rate).toBe(0);
    expect(response.summary.thresholds.passed).toBe(false);
    expect(response.summary.thresholds.failed).toContain(
      "payload_budget.compliance_rate",
    );
  });

  test("separates supporting file misses from primary file misses", async () => {
    await write("src/auth.ts", "export const AUTH_SCOPE = 'active';\n");
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "supporting files suite",
          queries: [
            {
              id: "auth-supporting",
              query: "active auth scope",
              expected_files: ["src/auth.ts"],
              supporting_files: ["src/secondary.ts"],
              tags: ["supporting"],
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
      limit: 3,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.results[0]?.files.matched).toEqual(["src/auth.ts"]);
    expect(response.results[0]?.files.missing).toEqual([]);
    expect(response.results[0]?.supporting_files.missing).toEqual([
      "src/secondary.ts",
    ]);
    expect(response.summary.files.recall_at_k).toBe(1);
    expect(response.summary.supporting_files.evaluated_queries).toBe(1);
    expect(response.summary.supporting_files.recall_at_k).toBe(0);
    expect(response.summary.audit.file_misses).toEqual([]);
    expect(response.summary.audit.supporting_file_misses).toEqual([
      expect.objectContaining({
        id: "auth-supporting",
        missing: ["src/secondary.ts"],
        tags: ["supporting"],
      }),
    ]);
  });

  test("summarizes benchmark misses, noise, and payload overruns for audit", async () => {
    const authSource = "export const AUTH_SCOPE = 'active auth scope';\n";
    await write("src/auth.ts", authSource);
    await write("src/noise.ts", "export const BILLING_SCOPE = 'invoice';\n");
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "benchmark audit suite",
          queries: [
            {
              id: "audit-query",
              query: "active auth scope missing memory",
              expected_files: ["src/auth.ts", "src/missing.ts"],
              expected_nodes: ["auth/missing"],
              forbidden_files: ["src/noise.ts"],
              forbidden_nodes: ["graph/noise"],
              response_budget_bytes: 10,
              tags: ["guardrail", "payload"],
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
        id: "graph/noise",
        name: "Active auth noisy memory",
        summary: "Mentions active auth scope but points at an unrelated file.",
        sources: [
          {
            file_path: "src/noise.ts",
            line_range: [1, 1],
            content_hash: hashBuffer(Buffer.from("stale-but-addressable")),
          },
        ],
      }),
    ]);

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 5,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.results[0]?.files.missing).toEqual(["src/missing.ts"]);
    expect(response.summary.audit.file_misses).toEqual([
      expect.objectContaining({
        id: "audit-query",
        missing: ["src/missing.ts"],
        matched: ["src/auth.ts"],
        tags: ["guardrail", "payload"],
      }),
    ]);
    expect(response.summary.audit.node_misses).toEqual([
      expect.objectContaining({
        id: "audit-query",
        missing: ["auth/missing"],
      }),
    ]);
    expect(response.summary.audit.forbidden_node_hits).toEqual([
      expect.objectContaining({
        id: "audit-query",
        forbidden_matched: ["graph/noise"],
      }),
    ]);
    expect(response.summary.audit.variant_forbidden_file_hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "audit-query",
          variant: "graph_files",
          forbidden_matched: ["src/noise.ts"],
        }),
      ]),
    );
    expect(response.summary.audit.payload_over_budget).toEqual([
      expect.objectContaining({
        id: "audit-query",
        response_budget_bytes: 10,
        over_budget_bytes: expect.any(Number),
      }),
    ]);
    expect(response.summary.audit.issue_tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "guardrail",
          query_ids: ["audit-query"],
        }),
        expect.objectContaining({
          tag: "payload",
          query_ids: ["audit-query"],
        }),
      ]),
    );
    expect(response.next_steps.join("\n")).toContain("summary.audit");
  });

  test("passes explicit query context budgets into planning benchmark runs", async () => {
    await write(
      "src/auth.ts",
      [
        "export function requireActiveUser(token: string) {",
        "  const auditTrail = [",
        ...Array.from(
          { length: 120 },
          (_value, index) =>
            `    "auth audit marker ${index} requireActiveUser active user planning benchmark budget",`,
        ),
        "  ];",
        "  return { id: auditTrail.includes(token) ? token : token };",
        "}",
      ].join("\n"),
    );
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "budgeted query context suite",
          queries: [
            {
              id: "budgeted-context",
              query: "requireActiveUser active user planning benchmark budget",
              expected_files: ["src/auth.ts"],
            },
          ],
        },
        null,
        2,
      ),
    );

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
      limit: 1,
      maxContentChars: 3000,
      responseBudgetBytes: 6500,
      minPayloadBudgetCompliance: 1,
      maxAverageResponseBytes: 6500,
      contextBudgetBytes: 6500,
    } as Parameters<typeof runRetrievalBenchmark>[1] & {
      contextBudgetBytes: number;
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.thresholds.passed).toBe(true);
    expect(response.summary.payload_budget.compliance_rate).toBe(1);
    expect(response.results[0]?.payload.within_budget).toBe(true);
    expect(response.results[0]?.files.matched).toEqual(["src/auth.ts"]);
  });

  test("uses context budgets as payload thresholds when response budgets are unset", async () => {
    await write("src/auth.ts", "export const AUTH_SCOPE = 'active';\n");
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "context-only budget suite",
          queries: [
            {
              id: "context-only-budget",
              query: "active auth scope",
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
      limit: 3,
      contextBudgetBytes: 1,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.results[0]?.payload.response_budget_bytes).toBe(1);
    expect(response.results[0]?.payload.within_budget).toBe(false);
    expect(response.results[0]?.payload.over_budget_bytes).toBeGreaterThan(0);
    expect(response.summary.payload_budget.evaluated_queries).toBe(1);
    expect(response.summary.payload_budget.compliance_rate).toBe(0);
    expect(response.summary.thresholds.passed).toBe(false);
    expect(response.summary.thresholds.failed).toContain(
      "payload_budget.compliance_rate",
    );
  });

  test("reports average response budgets and latency metrics", async () => {
    await write("src/auth.ts", "export const AUTH_SCOPE = 'active';\n");
    await write(
      "retrieval-suite.json",
      JSON.stringify(
        {
          version: 1,
          name: "average budget suite",
          queries: [
            {
              id: "auth-average-budget",
              query: "active auth scope",
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
      limit: 3,
      maxAverageResponseBytes: 1,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.summary.latency.average_latency_ms).toEqual(
      expect.any(Number),
    );
    expect(response.summary.latency.p50_latency_ms).toEqual(expect.any(Number));
    expect(response.summary.latency.p95_latency_ms).toEqual(expect.any(Number));
    expect(response.summary.latency.max_latency_ms).toEqual(expect.any(Number));
    expect(response.summary.latency.p50_latency_ms).toBeLessThanOrEqual(
      response.summary.latency.p95_latency_ms,
    );
    expect(response.summary.latency.p95_latency_ms).toBeLessThanOrEqual(
      response.summary.latency.max_latency_ms,
    );
    expect(response.summary.latency.p50_latency_ms).toBe(
      response.results[0]?.latency_ms,
    );
    expect(response.summary.latency.p95_latency_ms).toBe(
      response.results[0]?.latency_ms,
    );
    expect(response.summary.thresholds.passed).toBe(false);
    expect(response.summary.thresholds.failed).toEqual(
      expect.arrayContaining(["payload_budget.average_response_bytes"]),
    );
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

  test("rejects suites without any expectations", async () => {
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

  test("rejects invalid expected result sources", async () => {
    await write(
      "retrieval-suite.json",
      JSON.stringify({
        version: 1,
        name: "invalid result source suite",
        queries: [
          {
            id: "bad-source",
            query: "anything",
            expected_result_sources: ["capture"],
          },
        ],
      }),
    );

    const response = await runRetrievalBenchmark(tmpRoot, {
      suitePath: "retrieval-suite.json",
    });

    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("expected invalid suite");
    expect(response.error.code).toBe("SUITE_INVALID");
    expect(response.error.message).toContain("expected_result_sources");
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
