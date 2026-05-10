import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  buildQueryContext,
  type QueryContextMode,
  type SourceRefreshMode,
} from "./query_context.js";
import {
  getSourceIndexStatus,
  type SourceIndexStatus,
} from "./source_index.js";

const BENCHMARK_VERSION = 1 as const;
const DEFAULT_LIMIT = 10;
const DEFAULT_MODE: QueryContextMode = "standard";
const DEFAULT_MAX_CONTENT_CHARS = 300;
const DEFAULT_DEPENDENCY_LIMIT = 0;
const DEFAULT_IMPACT_LIMIT = 3;
const DEFAULT_REFRESH_INDEX: SourceRefreshMode = "if_missing";
const DEFAULT_SUITE_PATHS = [
  "benchmarks/retrieval.codemap.json",
  ".codemap/retrieval-benchmark.json",
];

export interface RetrievalBenchmarkQuery {
  id: string;
  query: string;
  expected_files?: string[];
  expected_nodes?: string[];
  tags?: string[];
}

export interface RetrievalBenchmarkSuite {
  version: typeof BENCHMARK_VERSION;
  name: string;
  description?: string;
  queries: RetrievalBenchmarkQuery[];
}

export interface RetrievalBenchmarkOptions {
  suitePath?: string;
  limit?: number;
  mode?: QueryContextMode;
  maxContentChars?: number;
  dependencyLimit?: number;
  includeImpact?: boolean;
  impactLimit?: number;
  refreshIndex?: SourceRefreshMode;
  minFileHitRate?: number;
  minNodeHitRate?: number;
}

export interface RetrievalTargetEvaluation {
  evaluated: boolean;
  expected: string[];
  returned: string[];
  matched: string[];
  hit: boolean;
  first_match_rank: number | null;
  reciprocal_rank: number;
  precision_at_k: number;
  recall_at_k: number;
}

export interface RetrievalBenchmarkQueryResult {
  id: string;
  query: string;
  tags: string[];
  latency_ms: number;
  response_bytes: number;
  source_result_count: number;
  source_file_diversity: number;
  files: RetrievalTargetEvaluation;
  nodes: RetrievalTargetEvaluation;
  warnings: string[];
}

export interface RetrievalBenchmarkAggregate {
  evaluated_queries: number;
  hit_rate_at_k: number;
  precision_at_k: number;
  recall_at_k: number;
  mrr: number;
}

export interface RetrievalBenchmarkSummary {
  query_count: number;
  limit: number;
  mode: QueryContextMode;
  total_time_ms: number;
  average_latency_ms: number;
  average_response_bytes: number;
  average_source_file_diversity: number;
  files: RetrievalBenchmarkAggregate;
  nodes: RetrievalBenchmarkAggregate;
  thresholds: {
    min_file_hit_rate?: number;
    min_node_hit_rate?: number;
    failed: string[];
    passed: boolean;
  };
  experimental: {
    embeddings: "disabled";
    reranking: "disabled";
    reason: string;
  };
}

export interface RetrievalBenchmarkOkResponse {
  ok: true;
  suite: {
    name: string;
    description?: string;
    path: string;
    version: number;
  };
  source: SourceIndexStatus;
  summary: RetrievalBenchmarkSummary;
  results: RetrievalBenchmarkQueryResult[];
  warnings: string[];
  next_steps: string[];
}

export interface RetrievalBenchmarkErrorResponse {
  ok: false;
  error: { code: string; message: string };
  suite_path?: string;
}

export type RetrievalBenchmarkResponse =
  | RetrievalBenchmarkOkResponse
  | RetrievalBenchmarkErrorResponse;

export async function runRetrievalBenchmark(
  repoRoot: string,
  options: RetrievalBenchmarkOptions = {},
): Promise<RetrievalBenchmarkResponse> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const suiteResolution = await resolveSuitePath(
    resolvedRepoRoot,
    options.suitePath,
  );
  if (!suiteResolution) {
    return {
      ok: false,
      error: {
        code: "SUITE_MISSING",
        message:
          "No retrieval benchmark suite found. Pass a suite path or create benchmarks/retrieval.codemap.json.",
      },
    };
  }

  let suite: RetrievalBenchmarkSuite;
  try {
    suite = parseSuite(
      await fs.readFile(suiteResolution.absolutePath, "utf8"),
      suiteResolution.relativePath,
    );
  } catch (err) {
    return {
      ok: false,
      suite_path: suiteResolution.relativePath,
      error: { code: "SUITE_INVALID", message: String(err) },
    };
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const mode = options.mode ?? DEFAULT_MODE;
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const dependencyLimit = options.dependencyLimit ?? DEFAULT_DEPENDENCY_LIMIT;
  const includeImpact = options.includeImpact ?? false;
  const impactLimit = options.impactLimit ?? DEFAULT_IMPACT_LIMIT;
  const refreshIndex = options.refreshIndex ?? DEFAULT_REFRESH_INDEX;
  const startedAt = Date.now();
  const results: RetrievalBenchmarkQueryResult[] = [];
  const warnings: string[] = [];

  for (const benchmarkQuery of suite.queries) {
    const queryStartedAt = Date.now();
    const context = await buildQueryContext(resolvedRepoRoot, benchmarkQuery.query, {
      mode,
      graphLimit: limit,
      sourceLimit: limit,
      maxContentChars,
      dependencyLimit,
      includeImpact,
      impactLimit,
      refreshIndex,
    });
    const latencyMs = Date.now() - queryStartedAt;
    const sourceResults = context.source.search?.ok
      ? context.source.search.results
      : [];
    const returnedFiles = unique(sourceResults.map((result) => result.file_path));
    const returnedNodes = context.graph.nodes.map((node) => node.id);
    const sourceFileDiversity =
      sourceResults.length === 0 ? 0 : returnedFiles.length / sourceResults.length;

    results.push({
      id: benchmarkQuery.id,
      query: benchmarkQuery.query,
      tags: benchmarkQuery.tags ?? [],
      latency_ms: latencyMs,
      response_bytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
      source_result_count: sourceResults.length,
      source_file_diversity: round4(sourceFileDiversity),
      files: evaluateTargets(
        (benchmarkQuery.expected_files ?? []).map(normalizeRepoPath),
        returnedFiles.map(normalizeRepoPath),
        limit,
      ),
      nodes: evaluateTargets(benchmarkQuery.expected_nodes ?? [], returnedNodes, limit),
      warnings: context.warnings,
    });
  }

  const source = await getSourceIndexStatus(resolvedRepoRoot);
  const totalTimeMs = Date.now() - startedAt;
  const summary = summarizeResults(results, {
    limit,
    mode,
    totalTimeMs,
    minFileHitRate: options.minFileHitRate,
    minNodeHitRate: options.minNodeHitRate,
  });

  if (!source.indexed) {
    warnings.push("Source index was missing; benchmark results may only reflect graph retrieval.");
  } else if (!source.fresh) {
    warnings.push("Source index is stale; refresh before comparing benchmark runs.");
  }

  return {
    ok: true,
    suite: {
      name: suite.name,
      description: suite.description,
      path: suiteResolution.relativePath,
      version: suite.version,
    },
    source,
    summary,
    results,
    warnings,
    next_steps: benchmarkNextSteps(summary),
  };
}

async function resolveSuitePath(
  repoRoot: string,
  suitePath?: string,
): Promise<{ absolutePath: string; relativePath: string } | null> {
  const candidates = suitePath ? [suitePath] : DEFAULT_SUITE_PATHS;
  for (const candidate of candidates) {
    const absolutePath = path.resolve(repoRoot, candidate);
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.isFile()) {
        return {
          absolutePath,
          relativePath: normalizeRepoPath(path.relative(repoRoot, absolutePath)),
        };
      }
    } catch {
      // Try the next default candidate.
    }
  }
  return null;
}

function parseSuite(content: string, suitePath: string): RetrievalBenchmarkSuite {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${suitePath} must contain a JSON object.`);
  }
  const value = parsed as Record<string, unknown>;
  if (value.version !== BENCHMARK_VERSION) {
    throw new Error(`${suitePath} must use version ${BENCHMARK_VERSION}.`);
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new Error(`${suitePath} must include a non-empty name.`);
  }
  if (!Array.isArray(value.queries) || value.queries.length === 0) {
    throw new Error(`${suitePath} must include at least one query.`);
  }

  const queries = value.queries.map((entry, index) =>
    parseQuery(entry, `${suitePath} queries[${index}]`),
  );

  return {
    version: BENCHMARK_VERSION,
    name: value.name,
    description:
      typeof value.description === "string" ? value.description : undefined,
    queries,
  };
}

function parseQuery(value: unknown, label: string): RetrievalBenchmarkQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
    throw new Error(`${label}.id must be a non-empty string.`);
  }
  if (typeof entry.query !== "string" || entry.query.trim().length === 0) {
    throw new Error(`${label}.query must be a non-empty string.`);
  }
  const expectedFiles = parseStringArray(entry.expected_files, `${label}.expected_files`);
  const expectedNodes = parseStringArray(entry.expected_nodes, `${label}.expected_nodes`);
  if (expectedFiles.length === 0 && expectedNodes.length === 0) {
    throw new Error(
      `${label} must include expected_files, expected_nodes, or both.`,
    );
  }
  return {
    id: entry.id,
    query: entry.query,
    expected_files: expectedFiles.map(normalizeRepoPath),
    expected_nodes: expectedNodes,
    tags: parseStringArray(entry.tags, `${label}.tags`, true),
  };
}

function parseStringArray(
  value: unknown,
  label: string,
  optional = false,
): string[] {
  if (value === undefined && optional) return [];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  if (strings.length !== value.length) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return strings;
}

function evaluateTargets(
  expected: string[],
  returned: string[],
  limit: number,
): RetrievalTargetEvaluation {
  const expectedSet = new Set(expected);
  const uniqueReturned = unique(returned);
  const matched = uniqueReturned.filter((target) => expectedSet.has(target));
  const firstMatchIndex = uniqueReturned.findIndex((target) =>
    expectedSet.has(target),
  );
  const firstMatchRank = firstMatchIndex >= 0 ? firstMatchIndex + 1 : null;
  return {
    evaluated: expected.length > 0,
    expected,
    returned: uniqueReturned,
    matched,
    hit: matched.length > 0,
    first_match_rank: firstMatchRank,
    reciprocal_rank: firstMatchRank ? round4(1 / firstMatchRank) : 0,
    precision_at_k: expected.length > 0 ? round4(matched.length / limit) : 0,
    recall_at_k:
      expected.length > 0 ? round4(matched.length / expected.length) : 0,
  };
}

function summarizeResults(
  results: RetrievalBenchmarkQueryResult[],
  input: {
    limit: number;
    mode: QueryContextMode;
    totalTimeMs: number;
    minFileHitRate?: number;
    minNodeHitRate?: number;
  },
): RetrievalBenchmarkSummary {
  const files = aggregateEvaluations(results.map((result) => result.files));
  const nodes = aggregateEvaluations(results.map((result) => result.nodes));
  const failed: string[] = [];
  if (
    input.minFileHitRate !== undefined &&
    files.evaluated_queries > 0 &&
    files.hit_rate_at_k < input.minFileHitRate
  ) {
    failed.push("files.hit_rate_at_k");
  }
  if (
    input.minNodeHitRate !== undefined &&
    nodes.evaluated_queries > 0 &&
    nodes.hit_rate_at_k < input.minNodeHitRate
  ) {
    failed.push("nodes.hit_rate_at_k");
  }

  return {
    query_count: results.length,
    limit: input.limit,
    mode: input.mode,
    total_time_ms: input.totalTimeMs,
    average_latency_ms: average(results.map((result) => result.latency_ms)),
    average_response_bytes: average(results.map((result) => result.response_bytes)),
    average_source_file_diversity: average(
      results.map((result) => result.source_file_diversity),
    ),
    files,
    nodes,
    thresholds: {
      min_file_hit_rate: input.minFileHitRate,
      min_node_hit_rate: input.minNodeHitRate,
      failed,
      passed: failed.length === 0,
    },
    experimental: {
      embeddings: "disabled",
      reranking: "disabled",
      reason:
        "Task 048 measures current local retrieval first; embeddings and reranking stay off until benchmark misses justify them.",
    },
  };
}

function aggregateEvaluations(
  evaluations: RetrievalTargetEvaluation[],
): RetrievalBenchmarkAggregate {
  const evaluated = evaluations.filter((entry) => entry.evaluated);
  if (evaluated.length === 0) {
    return {
      evaluated_queries: 0,
      hit_rate_at_k: 0,
      precision_at_k: 0,
      recall_at_k: 0,
      mrr: 0,
    };
  }
  return {
    evaluated_queries: evaluated.length,
    hit_rate_at_k: average(evaluated.map((entry) => (entry.hit ? 1 : 0))),
    precision_at_k: average(evaluated.map((entry) => entry.precision_at_k)),
    recall_at_k: average(evaluated.map((entry) => entry.recall_at_k)),
    mrr: average(evaluated.map((entry) => entry.reciprocal_rank)),
  };
}

function benchmarkNextSteps(summary: RetrievalBenchmarkSummary): string[] {
  const steps = [
    "Compare these baseline metrics before adding embeddings or reranking.",
  ];
  if (summary.files.hit_rate_at_k < 1 && summary.files.evaluated_queries > 0) {
    steps.push("Inspect file misses and decide whether lexical/symbol ranking needs tuning.");
  }
  if (summary.nodes.hit_rate_at_k < 1 && summary.nodes.evaluated_queries > 0) {
    steps.push("Inspect graph-node misses before changing memory-quality ranking.");
  }
  if (summary.thresholds.failed.length > 0) {
    steps.push(`Thresholds failed: ${summary.thresholds.failed.join(", ")}.`);
  }
  return steps;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round4(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}
