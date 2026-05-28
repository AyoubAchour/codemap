import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  buildQueryContext,
  type QueryContextMode,
  type SourceRefreshMode,
} from "./query_context.js";
import {
  type ResolvedSemanticReranker,
  type ResolvedSemanticRetrieval,
  resolveSemanticReranker,
  resolveSemanticRetrieval,
  runSemanticFileRetrieval,
  runSemanticRerank,
  type SemanticProviderKind,
  type SemanticRerankBenchmarkOptions,
  type SemanticRerankCandidate,
  type SemanticRetrievalBenchmarkOptions,
  type SemanticRetrievalFileHit,
} from "./semantic_retrieval.js";
import {
  getSourceIndexStatus,
  type SourceIndexStatus,
} from "./source_index.js";
import { normalizeRepoPath } from "./util/repo_path.js";

const BENCHMARK_VERSION = 1 as const;
const DEFAULT_LIMIT = 10;
const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_MODE: QueryContextMode = "standard";
const DEFAULT_RECALL_MODE: QueryContextMode = "compact";
const DEFAULT_MAX_CONTENT_CHARS = 300;
const DEFAULT_RECALL_MAX_CONTENT_CHARS = 120;
const DEFAULT_DEPENDENCY_LIMIT = 0;
const DEFAULT_IMPACT_LIMIT = 3;
const DEFAULT_REFRESH_INDEX: SourceRefreshMode = "if_stale";
const BENCHMARK_AUDIT_ITEM_LIMIT = 12;
const BENCHMARK_AUDIT_RETURNED_LIMIT = 12;
const BENCHMARK_AUDIT_TAG_LIMIT = 10;
const DEFAULT_SUITE_PATHS = [
  "benchmarks/retrieval.codemap.json",
  ".codemap/retrieval-benchmark.json",
];

export interface RetrievalBenchmarkQuery {
  id: string;
  query: string;
  expected_files?: string[];
  supporting_files?: string[];
  expected_nodes?: string[];
  forbidden_files?: string[];
  forbidden_nodes?: string[];
  expected_warnings?: string[];
  expected_result_sources?: RetrievalBenchmarkResultSource[];
  response_budget_bytes?: number;
  tags?: string[];
}

export type RetrievalBenchmarkProfile = "planning" | "recall";
export type RetrievalBenchmarkResultSource =
  | "graph"
  | "source"
  | "semantic"
  | "reranker";

export interface RetrievalBenchmarkSuite {
  version: typeof BENCHMARK_VERSION;
  name: string;
  description?: string;
  queries: RetrievalBenchmarkQuery[];
}

export interface RetrievalBenchmarkOptions {
  suitePath?: string;
  profile?: RetrievalBenchmarkProfile;
  limit?: number;
  mode?: QueryContextMode;
  maxContentChars?: number;
  dependencyLimit?: number;
  includeImpact?: boolean;
  impactLimit?: number;
  refreshIndex?: SourceRefreshMode;
  minFileHitRate?: number;
  minNodeHitRate?: number;
  responseBudgetBytes?: number;
  contextBudgetBytes?: number;
  minPayloadBudgetCompliance?: number;
  maxAverageResponseBytes?: number;
  maxAverageLatencyMs?: number;
  semantic?: SemanticRetrievalBenchmarkOptions;
  reranker?: SemanticRerankBenchmarkOptions;
}

export interface RetrievalTargetEvaluation {
  evaluated: boolean;
  expected: string[];
  returned: string[];
  matched: string[];
  missing: string[];
  forbidden: string[];
  forbidden_matched: string[];
  hit: boolean;
  clean: boolean;
  first_match_rank: number | null;
  reciprocal_rank: number;
  precision_at_k: number;
  recall_at_k: number;
  false_positive_rate_at_k: number;
}

export interface RetrievalExpectationEvaluation {
  evaluated: boolean;
  expected: string[];
  returned: string[];
  matched: string[];
  missing: string[];
  hit: boolean;
  recall_at_k: number;
}

export interface RetrievalBenchmarkQueryResult {
  id: string;
  query: string;
  tags: string[];
  latency_ms: number;
  response_bytes: number;
  payload: RetrievalPayloadBudgetResult;
  source_result_count: number;
  source_file_diversity: number;
  files: RetrievalTargetEvaluation;
  supporting_files: RetrievalTargetEvaluation;
  nodes: RetrievalTargetEvaluation;
  warning_expectations: RetrievalExpectationEvaluation;
  result_sources: RetrievalExpectationEvaluation;
  variants: RetrievalBenchmarkVariantResult;
  semantic: RetrievalBenchmarkSemanticResult;
  reranker: RetrievalBenchmarkRerankerResult;
  warnings: string[];
}

export interface RetrievalBenchmarkAggregate {
  evaluated_queries: number;
  hit_rate_at_k: number;
  precision_at_k: number;
  recall_at_k: number;
  mrr: number;
  forbidden_evaluated_queries: number;
  forbidden_violation_rate: number;
  false_positive_rate_at_k: number;
}

export interface RetrievalExpectationAggregate {
  evaluated_queries: number;
  hit_rate_at_k: number;
  recall_at_k: number;
}

export interface RetrievalPayloadBudgetResult {
  response_bytes: number;
  response_budget_bytes?: number;
  within_budget: boolean | null;
  over_budget_bytes: number;
}

export interface RetrievalPayloadBudgetSummary {
  evaluated_queries: number;
  within_budget_queries: number;
  compliance_rate: number;
  average_response_bytes: number;
  max_response_bytes: number;
  max_over_budget_bytes: number;
}

export type RetrievalBenchmarkVariantName = keyof RetrievalBenchmarkVariantResult;

export interface RetrievalBenchmarkAuditIssue {
  id: string;
  query: string;
  tags: string[];
  expected?: string[];
  returned?: string[];
  returned_truncated?: boolean;
  matched?: string[];
  missing?: string[];
  forbidden?: string[];
  forbidden_matched?: string[];
  first_match_rank?: number | null;
  precision_at_k?: number;
  recall_at_k?: number;
  response_bytes?: number;
  response_budget_bytes?: number;
  over_budget_bytes?: number;
}

export interface RetrievalBenchmarkVariantAuditIssue
  extends RetrievalBenchmarkAuditIssue {
  variant: RetrievalBenchmarkVariantName;
}

export interface RetrievalBenchmarkIssueTag {
  tag: string;
  issue_count: number;
  query_ids: string[];
}

export interface RetrievalBenchmarkAuditSummary {
  file_misses: RetrievalBenchmarkAuditIssue[];
  supporting_file_misses: RetrievalBenchmarkAuditIssue[];
  node_misses: RetrievalBenchmarkAuditIssue[];
  warning_misses: RetrievalBenchmarkAuditIssue[];
  result_source_misses: RetrievalBenchmarkAuditIssue[];
  forbidden_file_hits: RetrievalBenchmarkAuditIssue[];
  forbidden_node_hits: RetrievalBenchmarkAuditIssue[];
  variant_file_misses: RetrievalBenchmarkVariantAuditIssue[];
  variant_forbidden_file_hits: RetrievalBenchmarkVariantAuditIssue[];
  payload_over_budget: RetrievalBenchmarkAuditIssue[];
  issue_tags: RetrievalBenchmarkIssueTag[];
  truncated: boolean;
}

export interface RetrievalLatencySummary {
  average_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  max_latency_ms: number;
}

export interface RetrievalBenchmarkSummary {
  query_count: number;
  profile: RetrievalBenchmarkProfile;
  limit: number;
  mode: QueryContextMode;
  total_time_ms: number;
  average_latency_ms: number;
  average_response_bytes: number;
  latency: RetrievalLatencySummary;
  payload_budget: RetrievalPayloadBudgetSummary;
  average_source_file_diversity: number;
  files: RetrievalBenchmarkAggregate;
  supporting_files: RetrievalBenchmarkAggregate;
  nodes: RetrievalBenchmarkAggregate;
  warning_expectations: RetrievalExpectationAggregate;
  result_sources: RetrievalExpectationAggregate;
  variants: RetrievalBenchmarkVariantSummary;
  audit: RetrievalBenchmarkAuditSummary;
  thresholds: {
    min_file_hit_rate?: number;
    min_node_hit_rate?: number;
    response_budget_bytes?: number;
    context_budget_bytes?: number;
    min_payload_budget_compliance?: number;
    max_average_response_bytes?: number;
    max_average_latency_ms?: number;
    failed: string[];
    passed: boolean;
  };
  experimental: {
    embeddings: "disabled" | "adapter";
    reranking: "disabled" | "adapter";
    reason: string;
    semantic_retrieval: RetrievalBenchmarkSemanticSummary;
    reranker: RetrievalBenchmarkRerankerSummary;
  };
}

export interface RetrievalBenchmarkVariantResult {
  lexical_files: RetrievalTargetEvaluation;
  graph_files: RetrievalTargetEvaluation;
  mixed_files: RetrievalTargetEvaluation;
  local_vector_files: RetrievalTargetEvaluation;
}

export interface RetrievalBenchmarkVariantSummary {
  lexical_files: RetrievalBenchmarkAggregate;
  graph_files: RetrievalBenchmarkAggregate;
  mixed_files: RetrievalBenchmarkAggregate;
  local_vector_files: RetrievalBenchmarkAggregate;
}

export interface RetrievalBenchmarkSemanticResult {
  enabled: boolean;
  provider: string;
  provider_kind: SemanticProviderKind;
  latency_ms: number;
  hits: SemanticRetrievalFileHit[];
  files: RetrievalTargetEvaluation;
  warnings: string[];
}

export interface RetrievalBenchmarkSemanticSummary {
  enabled: boolean;
  provider: string;
  provider_kind: SemanticProviderKind;
  average_latency_ms: number;
  files: RetrievalBenchmarkAggregate;
  warnings: string[];
}

export interface RetrievalBenchmarkRerankerSummary {
  enabled: boolean;
  provider: string;
  provider_kind: SemanticProviderKind;
  average_latency_ms: number;
  files: RetrievalBenchmarkAggregate;
  warnings: string[];
}

export interface RetrievalBenchmarkRerankerResult {
  enabled: boolean;
  provider: string;
  provider_kind: SemanticProviderKind;
  latency_ms: number;
  hits: SemanticRetrievalFileHit[];
  files: RetrievalTargetEvaluation;
  warnings: string[];
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

  const profile = options.profile ?? "planning";
  const limit =
    options.limit ??
    (profile === "recall" ? DEFAULT_RECALL_LIMIT : DEFAULT_LIMIT);
  const mode =
    options.mode ?? (profile === "recall" ? DEFAULT_RECALL_MODE : DEFAULT_MODE);
  const maxContentChars =
    options.maxContentChars ??
    (profile === "recall"
      ? DEFAULT_RECALL_MAX_CONTENT_CHARS
      : DEFAULT_MAX_CONTENT_CHARS);
  const dependencyLimit = options.dependencyLimit ?? DEFAULT_DEPENDENCY_LIMIT;
  const includeImpact = options.includeImpact ?? false;
  const impactLimit = options.impactLimit ?? DEFAULT_IMPACT_LIMIT;
  const refreshIndex = options.refreshIndex ?? DEFAULT_REFRESH_INDEX;
  const semantic = resolveSemanticRetrieval(options.semantic);
  const reranker = resolveSemanticReranker(options.reranker);
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
      budgetBytes: options.contextBudgetBytes,
    });
    const latencyMs = Date.now() - queryStartedAt;
    const sourceResults = context.source.search?.ok
      ? context.source.search.results
      : [];
    const returnedFiles = unique(sourceResults.map((result) => result.file_path));
    const returnedNodes = context.graph.nodes.map((node) => node.id);
    const returnedGraphFiles = unique(
      context.graph.nodes.flatMap((node) =>
        node.sources.map((source) => normalizeRepoPath(source.file_path)),
      ),
    );
    const sourceFileDiversity =
      sourceResults.length === 0 ? 0 : returnedFiles.length / sourceResults.length;
    const expectedFiles = (benchmarkQuery.expected_files ?? []).map(normalizeRepoPath);
    const supportingFiles = (benchmarkQuery.supporting_files ?? []).map(
      normalizeRepoPath,
    );
    const forbiddenFiles = (benchmarkQuery.forbidden_files ?? []).map(normalizeRepoPath);
    const forbiddenNodes = benchmarkQuery.forbidden_nodes ?? [];
    const responseBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
    const responseBudgetBytes =
      options.responseBudgetBytes ?? benchmarkQuery.response_budget_bytes;
    const payloadBudgetBytes = effectivePayloadBudgetBytes(
      responseBudgetBytes,
      options.contextBudgetBytes,
    );
    const semanticRun = await runSemanticFileRetrieval(semantic, {
      repoRoot: resolvedRepoRoot,
      suitePath: suiteResolution.relativePath,
      queryId: benchmarkQuery.id,
      query: benchmarkQuery.query,
      limit,
    });
    for (const warning of semanticRun.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    const rerankRun = await runSemanticRerank(reranker, {
      repoRoot: resolvedRepoRoot,
      suitePath: suiteResolution.relativePath,
      queryId: benchmarkQuery.id,
      query: benchmarkQuery.query,
      candidates: sourceResults.map(toRerankCandidate),
      limit,
    });
    for (const warning of rerankRun.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    const lexicalFiles = evaluateTargets(
      expectedFiles,
      returnedFiles.map(normalizeRepoPath),
      forbiddenFiles,
    );
    const supportingFileEvaluation = evaluateTargets(
      supportingFiles,
      returnedFiles.map(normalizeRepoPath),
    );
    const graphFiles = evaluateTargets(
      expectedFiles,
      returnedGraphFiles,
      forbiddenFiles,
    );
    const mixedFiles = evaluateTargets(
      expectedFiles,
      unique([
        ...returnedFiles.map(normalizeRepoPath),
        ...returnedGraphFiles,
      ]),
      forbiddenFiles,
    );
    const semanticFiles = evaluateTargets(
      semanticRun.enabled ? expectedFiles : [],
      semanticRun.hits.map((hit) => hit.file_path),
      semanticRun.enabled ? forbiddenFiles : [],
    );
    const localVectorFiles = evaluateTargets(
      semanticRun.enabled && semanticRun.provider_kind === "local"
        ? expectedFiles
        : [],
      semanticRun.hits.map((hit) => hit.file_path),
      semanticRun.enabled && semanticRun.provider_kind === "local"
        ? forbiddenFiles
        : [],
    );
    const returnedResultSources = resultSources({
      graphNodeCount: context.graph.nodes.length,
      sourceResultCount: sourceResults.length,
      semanticHitCount: semanticRun.enabled ? semanticRun.hits.length : 0,
      rerankerHitCount: rerankRun.enabled ? rerankRun.hits.length : 0,
    });

    results.push({
      id: benchmarkQuery.id,
      query: benchmarkQuery.query,
      tags: benchmarkQuery.tags ?? [],
      latency_ms: latencyMs,
      response_bytes: responseBytes,
      payload: evaluatePayloadBudget(responseBytes, payloadBudgetBytes),
      source_result_count: sourceResults.length,
      source_file_diversity: round4(sourceFileDiversity),
      files: lexicalFiles,
      supporting_files: supportingFileEvaluation,
      nodes: evaluateTargets(
        benchmarkQuery.expected_nodes ?? [],
        returnedNodes,
        forbiddenNodes,
      ),
      warning_expectations: evaluateExpectations(
        benchmarkQuery.expected_warnings ?? [],
        context.warnings,
      ),
      result_sources: evaluateExpectations(
        benchmarkQuery.expected_result_sources ?? [],
        returnedResultSources,
      ),
      variants: {
        lexical_files: lexicalFiles,
        graph_files: graphFiles,
        mixed_files: mixedFiles,
        local_vector_files: localVectorFiles,
      },
      semantic: {
        enabled: semanticRun.enabled,
        provider: semanticRun.provider,
        provider_kind: semanticRun.provider_kind,
        latency_ms: semanticRun.latency_ms,
        hits: semanticRun.hits,
        files: semanticFiles,
        warnings: semanticRun.warnings,
      },
      reranker: {
        enabled: rerankRun.enabled,
        provider: rerankRun.provider,
        provider_kind: rerankRun.provider_kind,
        latency_ms: rerankRun.latency_ms,
        hits: rerankRun.hits,
        files: evaluateTargets(
          rerankRun.enabled ? expectedFiles : [],
          rerankRun.hits.map((hit) => hit.file_path),
          rerankRun.enabled ? forbiddenFiles : [],
        ),
        warnings: rerankRun.warnings,
      },
      warnings: context.warnings,
    });
  }

  const source = await getSourceIndexStatus(resolvedRepoRoot);
  const totalTimeMs = Date.now() - startedAt;
  const summary = summarizeResults(results, {
    limit,
    profile,
    mode,
    totalTimeMs,
    minFileHitRate: options.minFileHitRate,
    minNodeHitRate: options.minNodeHitRate,
    responseBudgetBytes: options.responseBudgetBytes,
    contextBudgetBytes: options.contextBudgetBytes,
    minPayloadBudgetCompliance: options.minPayloadBudgetCompliance,
    maxAverageResponseBytes: options.maxAverageResponseBytes,
    maxAverageLatencyMs: options.maxAverageLatencyMs,
    semantic,
    reranker,
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
  const expectedFiles = parseOptionalStringArray(
    entry.expected_files,
    `${label}.expected_files`,
  );
  const supportingFiles = parseOptionalStringArray(
    entry.supporting_files,
    `${label}.supporting_files`,
  );
  const expectedNodes = parseOptionalStringArray(
    entry.expected_nodes,
    `${label}.expected_nodes`,
  );
  const forbiddenFiles = parseOptionalStringArray(
    entry.forbidden_files,
    `${label}.forbidden_files`,
  );
  const forbiddenNodes = parseOptionalStringArray(
    entry.forbidden_nodes,
    `${label}.forbidden_nodes`,
  );
  const expectedWarnings = parseOptionalStringArray(
    entry.expected_warnings,
    `${label}.expected_warnings`,
  );
  const expectedResultSources = parseOptionalResultSources(
    entry.expected_result_sources,
    `${label}.expected_result_sources`,
  );
  const responseBudgetBytes = parseOptionalPositiveInteger(
    entry.response_budget_bytes,
    `${label}.response_budget_bytes`,
  );
  if (
    expectedFiles.length === 0 &&
    supportingFiles.length === 0 &&
    expectedNodes.length === 0 &&
    forbiddenFiles.length === 0 &&
    forbiddenNodes.length === 0 &&
    expectedWarnings.length === 0 &&
    expectedResultSources.length === 0
  ) {
    throw new Error(
      `${label} must include at least one expected, forbidden, warning, or result-source expectation.`,
    );
  }
  return {
    id: entry.id,
    query: entry.query,
    expected_files: expectedFiles.map(normalizeRepoPath),
    supporting_files: supportingFiles.map(normalizeRepoPath),
    expected_nodes: expectedNodes,
    forbidden_files: forbiddenFiles.map(normalizeRepoPath),
    forbidden_nodes: forbiddenNodes,
    expected_warnings: expectedWarnings,
    expected_result_sources: expectedResultSources,
    response_budget_bytes: responseBudgetBytes,
    tags: parseOptionalStringArray(entry.tags, `${label}.tags`),
  };
}

function parseOptionalResultSources(
  value: unknown,
  label: string,
): RetrievalBenchmarkResultSource[] {
  const values = parseOptionalStringArray(value, label);
  const allowed = new Set<RetrievalBenchmarkResultSource>([
    "graph",
    "source",
    "semantic",
    "reranker",
  ]);
  for (const entry of values) {
    if (!allowed.has(entry as RetrievalBenchmarkResultSource)) {
      throw new Error(
        `${label} must contain only graph, source, semantic, or reranker.`,
      );
    }
  }
  return values as RetrievalBenchmarkResultSource[];
}

function parseOptionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  return parseStringArray(value, label);
}

function parseStringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    throw new Error(`${label} must be an array of strings.`);
  }
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

function parseOptionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function evaluateTargets(
  expected: string[],
  returned: string[],
  forbidden: string[] = [],
): RetrievalTargetEvaluation {
  const expectedSet = new Set(expected);
  const forbiddenSet = new Set(forbidden);
  const uniqueReturned = unique(returned);
  const matched = uniqueReturned.filter((target) => expectedSet.has(target));
  const missing = expected.filter((target) => !matched.includes(target));
  const forbiddenMatched = uniqueReturned.filter((target) =>
    forbiddenSet.has(target),
  );
  const firstMatchIndex = uniqueReturned.findIndex((target) =>
    expectedSet.has(target),
  );
  const firstMatchRank = firstMatchIndex >= 0 ? firstMatchIndex + 1 : null;
  return {
    evaluated: expected.length > 0,
    expected,
    returned: uniqueReturned,
    matched,
    missing,
    forbidden,
    forbidden_matched: forbiddenMatched,
    hit: matched.length > 0,
    clean: forbidden.length === 0 || forbiddenMatched.length === 0,
    first_match_rank: firstMatchRank,
    reciprocal_rank: firstMatchRank ? round4(1 / firstMatchRank) : 0,
    precision_at_k:
      expected.length > 0 && uniqueReturned.length > 0
        ? round4(matched.length / uniqueReturned.length)
        : 0,
    recall_at_k:
      expected.length > 0 ? round4(matched.length / expected.length) : 0,
    false_positive_rate_at_k:
      forbidden.length > 0 && uniqueReturned.length > 0
        ? round4(forbiddenMatched.length / uniqueReturned.length)
        : 0,
  };
}

function evaluateExpectations(
  expected: string[],
  returned: string[],
): RetrievalExpectationEvaluation {
  const uniqueReturned = unique(returned);
  const matched = expected.filter((entry) =>
    uniqueReturned.some((result) => result.includes(entry)),
  );
  return {
    evaluated: expected.length > 0,
    expected,
    returned: uniqueReturned,
    matched,
    missing: expected.filter((entry) => !matched.includes(entry)),
    hit: expected.length > 0 && matched.length === expected.length,
    recall_at_k:
      expected.length > 0 ? round4(matched.length / expected.length) : 0,
  };
}

function summarizeResults(
  results: RetrievalBenchmarkQueryResult[],
  input: {
    limit: number;
    profile: RetrievalBenchmarkProfile;
    mode: QueryContextMode;
    totalTimeMs: number;
    minFileHitRate?: number;
    minNodeHitRate?: number;
    responseBudgetBytes?: number;
    contextBudgetBytes?: number;
    minPayloadBudgetCompliance?: number;
    maxAverageResponseBytes?: number;
    maxAverageLatencyMs?: number;
    semantic: ResolvedSemanticRetrieval;
    reranker: ResolvedSemanticReranker;
  },
): RetrievalBenchmarkSummary {
  const files = aggregateEvaluations(results.map((result) => result.files));
  const supportingFiles = aggregateEvaluations(
    results.map((result) => result.supporting_files),
  );
  const nodes = aggregateEvaluations(results.map((result) => result.nodes));
  const warningExpectations = aggregateExpectations(
    results.map((result) => result.warning_expectations),
  );
  const resultSources = aggregateExpectations(
    results.map((result) => result.result_sources),
  );
  const variants: RetrievalBenchmarkVariantSummary = {
    lexical_files: aggregateEvaluations(
      results.map((result) => result.variants.lexical_files),
    ),
    graph_files: aggregateEvaluations(
      results.map((result) => result.variants.graph_files),
    ),
    mixed_files: aggregateEvaluations(
      results.map((result) => result.variants.mixed_files),
    ),
    local_vector_files: aggregateEvaluations(
      results.map((result) => result.variants.local_vector_files),
    ),
  };
  const averageLatencyMs = average(results.map((result) => result.latency_ms));
  const averageResponseBytes = average(
    results.map((result) => result.response_bytes),
  );
  const payloadBudget = aggregatePayloadBudgets(
    results.map((result) => result.payload),
  );
  const semanticFiles = aggregateEvaluations(
    results.map((result) => result.semantic.files),
  );
  const rerankerFiles = aggregateEvaluations(
    results.map((result) => result.reranker.files),
  );
  const audit = summarizeAudit(results);
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
  const minPayloadBudgetCompliance =
    input.minPayloadBudgetCompliance ??
    (input.responseBudgetBytes !== undefined ||
    payloadBudget.evaluated_queries > 0
      ? 1
      : undefined);
  if (
    minPayloadBudgetCompliance !== undefined &&
    (payloadBudget.evaluated_queries === 0 ||
      payloadBudget.compliance_rate < minPayloadBudgetCompliance)
  ) {
    failed.push("payload_budget.compliance_rate");
  }
  if (
    input.maxAverageResponseBytes !== undefined &&
    averageResponseBytes > input.maxAverageResponseBytes
  ) {
    failed.push("payload_budget.average_response_bytes");
  }
  if (
    input.maxAverageLatencyMs !== undefined &&
    averageLatencyMs > input.maxAverageLatencyMs
  ) {
    failed.push("latency.average_latency_ms");
  }

  return {
    query_count: results.length,
    profile: input.profile,
    limit: input.limit,
    mode: input.mode,
    total_time_ms: input.totalTimeMs,
    average_latency_ms: averageLatencyMs,
    average_response_bytes: averageResponseBytes,
    latency: {
      average_latency_ms: averageLatencyMs,
      p50_latency_ms: percentile(
        results.map((result) => result.latency_ms),
        50,
      ),
      p95_latency_ms: percentile(
        results.map((result) => result.latency_ms),
        95,
      ),
      max_latency_ms: max(results.map((result) => result.latency_ms)),
    },
    payload_budget: payloadBudget,
    average_source_file_diversity: average(
      results.map((result) => result.source_file_diversity),
    ),
    files,
    supporting_files: supportingFiles,
    nodes,
    warning_expectations: warningExpectations,
    result_sources: resultSources,
    variants,
    audit,
    thresholds: {
      min_file_hit_rate: input.minFileHitRate,
      min_node_hit_rate: input.minNodeHitRate,
      response_budget_bytes: input.responseBudgetBytes,
      context_budget_bytes: input.contextBudgetBytes,
      min_payload_budget_compliance: minPayloadBudgetCompliance,
      max_average_response_bytes: input.maxAverageResponseBytes,
      max_average_latency_ms: input.maxAverageLatencyMs,
      failed,
      passed: failed.length === 0,
    },
    experimental: {
      embeddings: input.semantic.enabled ? "adapter" : "disabled",
      reranking: input.reranker.enabled ? "adapter" : "disabled",
      reason:
        "Semantic retrieval and reranking are disabled by default; adapter experiments must be explicit and benchmarked here before runtime use.",
      semantic_retrieval: {
        enabled: input.semantic.enabled,
        provider: input.semantic.provider,
        provider_kind: input.semantic.provider_kind,
        average_latency_ms: average(
          results.map((result) => result.semantic.latency_ms),
        ),
        files: semanticFiles,
        warnings:
          input.semantic.provider_kind === "cloud"
            ? [
                `Cloud semantic retrieval provider ${input.semantic.provider} is opt-in; default Codemap benchmark runs remain local-only.`,
              ]
            : [],
      },
      reranker: {
        enabled: input.reranker.enabled,
        provider: input.reranker.provider,
        provider_kind: input.reranker.provider_kind,
        average_latency_ms: average(
          results.map((result) => result.reranker.latency_ms),
        ),
        files: rerankerFiles,
        warnings:
          input.reranker.provider_kind === "cloud"
            ? [
                `Cloud reranker provider ${input.reranker.provider} is opt-in; default Codemap benchmark runs remain local-only.`,
              ]
            : [],
      },
    },
  };
}

function summarizeAudit(
  results: RetrievalBenchmarkQueryResult[],
): RetrievalBenchmarkAuditSummary {
  const fileMisses = results
    .filter((result) => result.files.evaluated && result.files.missing.length > 0)
    .map((result) => targetAuditIssue(result, result.files));
  const supportingFileMisses = results
    .filter(
      (result) =>
        result.supporting_files.evaluated &&
        result.supporting_files.missing.length > 0,
    )
    .map((result) => targetAuditIssue(result, result.supporting_files));
  const nodeMisses = results
    .filter((result) => result.nodes.evaluated && result.nodes.missing.length > 0)
    .map((result) => targetAuditIssue(result, result.nodes));
  const warningMisses = results
    .filter(
      (result) =>
        result.warning_expectations.evaluated &&
        result.warning_expectations.missing.length > 0,
    )
    .map((result) =>
      expectationAuditIssue(result, result.warning_expectations),
    );
  const resultSourceMisses = results
    .filter(
      (result) =>
        result.result_sources.evaluated &&
        result.result_sources.missing.length > 0,
    )
    .map((result) => expectationAuditIssue(result, result.result_sources));
  const forbiddenFileHits = results
    .filter((result) => result.files.forbidden_matched.length > 0)
    .map((result) => targetAuditIssue(result, result.files));
  const forbiddenNodeHits = results
    .filter((result) => result.nodes.forbidden_matched.length > 0)
    .map((result) => targetAuditIssue(result, result.nodes));
  const variantFileMisses: RetrievalBenchmarkVariantAuditIssue[] = [];
  const variantForbiddenFileHits: RetrievalBenchmarkVariantAuditIssue[] = [];
  const fileVariants: RetrievalBenchmarkVariantName[] = [
    "graph_files",
    "mixed_files",
    "local_vector_files",
  ];
  for (const result of results) {
    for (const variant of fileVariants) {
      const evaluation = result.variants[variant];
      if (evaluation.evaluated && evaluation.missing.length > 0) {
        variantFileMisses.push(variantAuditIssue(result, variant, evaluation));
      }
      if (evaluation.forbidden_matched.length > 0) {
        variantForbiddenFileHits.push(
          variantAuditIssue(result, variant, evaluation),
        );
      }
    }
  }
  const payloadOverBudget = results
    .filter((result) => result.payload.within_budget === false)
    .map(payloadAuditIssue);
  const allIssues: RetrievalBenchmarkAuditIssue[] = [
    ...fileMisses,
    ...supportingFileMisses,
    ...nodeMisses,
    ...warningMisses,
    ...resultSourceMisses,
    ...forbiddenFileHits,
    ...forbiddenNodeHits,
    ...variantFileMisses,
    ...variantForbiddenFileHits,
    ...payloadOverBudget,
  ];
  const issueTags = summarizeIssueTags(allIssues);

  return {
    file_misses: limitAuditItems(fileMisses),
    supporting_file_misses: limitAuditItems(supportingFileMisses),
    node_misses: limitAuditItems(nodeMisses),
    warning_misses: limitAuditItems(warningMisses),
    result_source_misses: limitAuditItems(resultSourceMisses),
    forbidden_file_hits: limitAuditItems(forbiddenFileHits),
    forbidden_node_hits: limitAuditItems(forbiddenNodeHits),
    variant_file_misses: limitAuditItems(variantFileMisses),
    variant_forbidden_file_hits: limitAuditItems(variantForbiddenFileHits),
    payload_over_budget: limitAuditItems(payloadOverBudget),
    issue_tags: issueTags.slice(0, BENCHMARK_AUDIT_TAG_LIMIT),
    truncated:
      fileMisses.length > BENCHMARK_AUDIT_ITEM_LIMIT ||
      supportingFileMisses.length > BENCHMARK_AUDIT_ITEM_LIMIT ||
      nodeMisses.length > BENCHMARK_AUDIT_ITEM_LIMIT ||
      warningMisses.length > BENCHMARK_AUDIT_ITEM_LIMIT ||
      resultSourceMisses.length > BENCHMARK_AUDIT_ITEM_LIMIT ||
      forbiddenFileHits.length > BENCHMARK_AUDIT_ITEM_LIMIT ||
      forbiddenNodeHits.length > BENCHMARK_AUDIT_ITEM_LIMIT ||
      variantFileMisses.length > BENCHMARK_AUDIT_ITEM_LIMIT ||
      variantForbiddenFileHits.length > BENCHMARK_AUDIT_ITEM_LIMIT ||
      payloadOverBudget.length > BENCHMARK_AUDIT_ITEM_LIMIT ||
      allIssues.some((issue) => issue.returned_truncated === true) ||
      issueTags.length > BENCHMARK_AUDIT_TAG_LIMIT,
  };
}

function targetAuditIssue(
  result: RetrievalBenchmarkQueryResult,
  evaluation: RetrievalTargetEvaluation,
): RetrievalBenchmarkAuditIssue {
  return {
    id: result.id,
    query: result.query,
    tags: result.tags,
    expected: evaluation.expected,
    returned: limitAuditReturned(evaluation.returned),
    returned_truncated:
      evaluation.returned.length > BENCHMARK_AUDIT_RETURNED_LIMIT
        ? true
        : undefined,
    matched: evaluation.matched,
    missing: evaluation.missing,
    forbidden: evaluation.forbidden,
    forbidden_matched: evaluation.forbidden_matched,
    first_match_rank: evaluation.first_match_rank,
    precision_at_k: evaluation.precision_at_k,
    recall_at_k: evaluation.recall_at_k,
  };
}

function expectationAuditIssue(
  result: RetrievalBenchmarkQueryResult,
  evaluation: RetrievalExpectationEvaluation,
): RetrievalBenchmarkAuditIssue {
  return {
    id: result.id,
    query: result.query,
    tags: result.tags,
    expected: evaluation.expected,
    returned: limitAuditReturned(evaluation.returned),
    returned_truncated:
      evaluation.returned.length > BENCHMARK_AUDIT_RETURNED_LIMIT
        ? true
        : undefined,
    matched: evaluation.matched,
    missing: evaluation.missing,
    recall_at_k: evaluation.recall_at_k,
  };
}

function variantAuditIssue(
  result: RetrievalBenchmarkQueryResult,
  variant: RetrievalBenchmarkVariantName,
  evaluation: RetrievalTargetEvaluation,
): RetrievalBenchmarkVariantAuditIssue {
  return {
    ...targetAuditIssue(result, evaluation),
    variant,
  };
}

function payloadAuditIssue(
  result: RetrievalBenchmarkQueryResult,
): RetrievalBenchmarkAuditIssue {
  return {
    id: result.id,
    query: result.query,
    tags: result.tags,
    response_bytes: result.payload.response_bytes,
    response_budget_bytes: result.payload.response_budget_bytes,
    over_budget_bytes: result.payload.over_budget_bytes,
  };
}

function limitAuditItems<T>(items: T[]): T[] {
  return items.slice(0, BENCHMARK_AUDIT_ITEM_LIMIT);
}

function limitAuditReturned(values: string[]): string[] {
  return values.slice(0, BENCHMARK_AUDIT_RETURNED_LIMIT);
}

function summarizeIssueTags(
  issues: RetrievalBenchmarkAuditIssue[],
): RetrievalBenchmarkIssueTag[] {
  const tags = new Map<
    string,
    { issue_count: number; query_ids: Set<string> }
  >();
  for (const issue of issues) {
    for (const tag of issue.tags) {
      const entry = tags.get(tag) ?? {
        issue_count: 0,
        query_ids: new Set<string>(),
      };
      entry.issue_count += 1;
      entry.query_ids.add(issue.id);
      tags.set(tag, entry);
    }
  }
  return [...tags.entries()]
    .map(([tag, entry]) => ({
      tag,
      issue_count: entry.issue_count,
      query_ids: [...entry.query_ids].sort().slice(0, BENCHMARK_AUDIT_ITEM_LIMIT),
    }))
    .sort(
      (left, right) =>
        right.issue_count - left.issue_count || left.tag.localeCompare(right.tag),
    );
}

function evaluatePayloadBudget(
  responseBytes: number,
  responseBudgetBytes?: number,
): RetrievalPayloadBudgetResult {
  return {
    response_bytes: responseBytes,
    response_budget_bytes: responseBudgetBytes,
    within_budget:
      responseBudgetBytes === undefined ? null : responseBytes <= responseBudgetBytes,
    over_budget_bytes:
      responseBudgetBytes === undefined
        ? 0
        : Math.max(0, responseBytes - responseBudgetBytes),
  };
}

function effectivePayloadBudgetBytes(
  responseBudgetBytes?: number,
  contextBudgetBytes?: number,
): number | undefined {
  if (responseBudgetBytes === undefined) return contextBudgetBytes;
  if (contextBudgetBytes === undefined) return responseBudgetBytes;
  return Math.min(responseBudgetBytes, contextBudgetBytes);
}

function aggregatePayloadBudgets(
  payloads: RetrievalPayloadBudgetResult[],
): RetrievalPayloadBudgetSummary {
  const evaluated = payloads.filter(
    (payload) => payload.response_budget_bytes !== undefined,
  );
  return {
    evaluated_queries: evaluated.length,
    within_budget_queries: evaluated.filter(
      (payload) => payload.within_budget === true,
    ).length,
    compliance_rate:
      evaluated.length === 0
        ? 0
        : average(evaluated.map((payload) => (payload.within_budget ? 1 : 0))),
    average_response_bytes: average(
      payloads.map((payload) => payload.response_bytes),
    ),
    max_response_bytes: max(payloads.map((payload) => payload.response_bytes)),
    max_over_budget_bytes: max(
      evaluated.map((payload) => payload.over_budget_bytes),
    ),
  };
}

function aggregateEvaluations(
  evaluations: RetrievalTargetEvaluation[],
): RetrievalBenchmarkAggregate {
  const evaluated = evaluations.filter((entry) => entry.evaluated);
  const forbiddenEvaluated = evaluations.filter(
    (entry) => entry.forbidden.length > 0,
  );
  if (evaluated.length === 0) {
    return {
      evaluated_queries: 0,
      hit_rate_at_k: 0,
      precision_at_k: 0,
      recall_at_k: 0,
      mrr: 0,
      forbidden_evaluated_queries: forbiddenEvaluated.length,
      forbidden_violation_rate: average(
        forbiddenEvaluated.map((entry) => (entry.clean ? 0 : 1)),
      ),
      false_positive_rate_at_k: average(
        forbiddenEvaluated.map((entry) => entry.false_positive_rate_at_k),
      ),
    };
  }
  return {
    evaluated_queries: evaluated.length,
    hit_rate_at_k: average(evaluated.map((entry) => (entry.hit ? 1 : 0))),
    precision_at_k: average(evaluated.map((entry) => entry.precision_at_k)),
    recall_at_k: average(evaluated.map((entry) => entry.recall_at_k)),
    mrr: average(evaluated.map((entry) => entry.reciprocal_rank)),
    forbidden_evaluated_queries: forbiddenEvaluated.length,
    forbidden_violation_rate: average(
      forbiddenEvaluated.map((entry) => (entry.clean ? 0 : 1)),
    ),
    false_positive_rate_at_k: average(
      forbiddenEvaluated.map((entry) => entry.false_positive_rate_at_k),
    ),
  };
}

function aggregateExpectations(
  evaluations: RetrievalExpectationEvaluation[],
): RetrievalExpectationAggregate {
  const evaluated = evaluations.filter((entry) => entry.evaluated);
  if (evaluated.length === 0) {
    return {
      evaluated_queries: 0,
      hit_rate_at_k: 0,
      recall_at_k: 0,
    };
  }
  return {
    evaluated_queries: evaluated.length,
    hit_rate_at_k: average(evaluated.map((entry) => (entry.hit ? 1 : 0))),
    recall_at_k: average(evaluated.map((entry) => entry.recall_at_k)),
  };
}

function resultSources(input: {
  graphNodeCount: number;
  sourceResultCount: number;
  semanticHitCount: number;
  rerankerHitCount: number;
}): RetrievalBenchmarkResultSource[] {
  const sources: RetrievalBenchmarkResultSource[] = [];
  if (input.graphNodeCount > 0) sources.push("graph");
  if (input.sourceResultCount > 0) sources.push("source");
  if (input.semanticHitCount > 0) sources.push("semantic");
  if (input.rerankerHitCount > 0) sources.push("reranker");
  return sources;
}

function toRerankCandidate(result: {
  file_path: string;
  score: number;
  content?: string;
}): SemanticRerankCandidate {
  return {
    file_path: normalizeRepoPath(result.file_path),
    score: result.score,
    content: result.content,
  };
}

function benchmarkNextSteps(summary: RetrievalBenchmarkSummary): string[] {
  const steps = [
    "Compare these baseline metrics before adding embeddings or reranking.",
  ];
  if (benchmarkAuditIssueCount(summary.audit) > 0) {
    steps.push(
      "Inspect summary.audit for per-query misses, noisy variants, and payload overruns before changing retrieval ranking.",
    );
  }
  if (summary.files.hit_rate_at_k < 1 && summary.files.evaluated_queries > 0) {
    steps.push("Inspect file misses and decide whether lexical/symbol ranking needs tuning.");
  }
  if (summary.audit.supporting_file_misses.length > 0) {
    steps.push(
      "Inspect supporting file misses separately from primary retrieval failures; they track useful secondary context.",
    );
  }
  if (summary.nodes.hit_rate_at_k < 1 && summary.nodes.evaluated_queries > 0) {
    steps.push("Inspect graph-node misses before changing memory-quality ranking.");
  }
  if (summary.thresholds.failed.length > 0) {
    steps.push(`Thresholds failed: ${summary.thresholds.failed.join(", ")}.`);
  }
  if (summary.files.forbidden_violation_rate > 0) {
    steps.push("Inspect forbidden file hits; irrelevant source context is consuming the agent budget.");
  }
  if (summary.nodes.forbidden_violation_rate > 0) {
    steps.push("Inspect forbidden graph hits; noisy or stale memory may be outranking useful context.");
  }
  if (
    summary.warning_expectations.evaluated_queries > 0 &&
    summary.warning_expectations.recall_at_k < 1
  ) {
    steps.push("Inspect missing warning expectations before trusting graph/source provenance signals.");
  }
  if (
    summary.result_sources.evaluated_queries > 0 &&
    summary.result_sources.recall_at_k < 1
  ) {
    steps.push("Inspect result-source misses; the benchmark expected evidence from a source that was absent.");
  }
  if (summary.variants.local_vector_files.evaluated_queries > 0) {
    const localRecall = summary.variants.local_vector_files.recall_at_k;
    const lexicalRecall = summary.variants.lexical_files.recall_at_k;
    if (localRecall <= lexicalRecall) {
      steps.push(
        "Local-vector recall did not beat lexical recall; keep semantic retrieval benchmark-only unless another provider improves the tradeoff.",
      );
    }
  }
  return steps;
}

function benchmarkAuditIssueCount(audit: RetrievalBenchmarkAuditSummary): number {
  return (
    audit.file_misses.length +
    audit.supporting_file_misses.length +
    audit.node_misses.length +
    audit.warning_misses.length +
    audit.result_source_misses.length +
    audit.forbidden_file_hits.length +
    audit.forbidden_node_hits.length +
    audit.variant_file_misses.length +
    audit.variant_forbidden_file_hits.length +
    audit.payload_over_budget.length
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round4(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function max(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index] ?? 0;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
