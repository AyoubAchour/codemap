import { GraphStore, type QueryResult } from "./graph.js";
import {
  filterStalenessReportForNodes,
  type GraphMemoryQuality,
  type GraphMemoryQualitySummary,
  rankGraphResultByQuality,
  summarizeGraphMemoryQuality,
} from "./graph_quality.js";
import {
  buildRepoMap,
  type RepoMapFileSummary,
  type RepoMapSummary,
  type RepoMapSymbolRank,
  repoMapFileSummary,
} from "./repo_map.js";
import {
  getSourceIndexStatus,
  loadSourceIndex,
  type SourceIndex,
  type SourceIndexStatus,
  type SourceSearchResponse,
  scanSourceIndex,
  searchSourceIndex,
} from "./source_index.js";
import { checkSourceStaleness, type StalenessReport } from "./staleness.js";
import type { Node } from "./types.js";

export type SourceRefreshMode = "never" | "if_missing" | "if_stale";
export type QueryContextMode = "compact" | "standard" | "full";
export type QueryContextBudgetLane =
  | "summary"
  | "graph"
  | "source"
  | "repo_map"
  | "related_nodes"
  | "expansion"
  | "warnings";

export interface QueryContextOptions {
  mode?: QueryContextMode;
  graphLimit?: number;
  sourceLimit?: number;
  maxContentChars?: number;
  dependencyLimit?: number;
  refreshIndex?: SourceRefreshMode;
  includeImpact?: boolean;
  impactLimit?: number;
  budgetBytes?: number;
}

export interface QueryContextPackingLaneStats {
  candidates: number;
  selected: number;
  omitted: number;
  omitted_by_budget: number;
  used_bytes: number;
}

export interface QueryContextPackingSummary {
  strategy: "planning_detail_budget_v1";
  lanes: Partial<
    Record<QueryContextBudgetLane, QueryContextPackingLaneStats>
  >;
}

export interface QueryContextBudgetSummary {
  budget_bytes: number;
  used_bytes: number;
  remaining_bytes: number;
  within_budget: boolean;
  truncated: boolean;
  packing: QueryContextPackingSummary;
}

export interface QueryContextGraphMemorySummary {
  id: string;
  kind: Node["kind"];
  name: string;
  trust?: string;
  freshness?: string;
  score?: number;
  ranking_score?: number;
  match_reasons: string[];
  quality_reasons: string[];
  quality_signals?: GraphMemoryQuality["signals"];
}

export interface QueryContextSourceHitSummary {
  file_path: string;
  start_line: number;
  end_line: number;
  chunk_type: string;
  score: number;
  matched_symbols: string[];
  match_reasons: string[];
  has_dependency_context: boolean;
  has_impact_context: boolean;
}

export interface QueryContextRepoMapSummary {
  summary: RepoMapSummary;
  files: RepoMapFileSummary[];
  symbols: RepoMapSymbolRank[];
}

export interface QueryContextSummary {
  graph_memories: QueryContextGraphMemorySummary[];
  source_hits: QueryContextSourceHitSummary[];
  repo_map: QueryContextRepoMapSummary;
  source_index: Pick<
    SourceIndexStatus,
    | "chunks_indexed"
    | "files_indexed"
    | "fresh"
    | "indexed"
    | "missing_files"
    | "new_files"
    | "stale_files"
    | "symbols_indexed"
  > & { refreshed: boolean };
  totals: {
    graph_nodes: number;
    related_nodes: number;
    repo_map_files: number;
    source_results: number;
    stale_graph_sources: number;
    warnings: number;
  };
}

export interface QueryContextExpansion {
  graph_nodes: Array<{
    id: string;
    tool: "get_node";
    arguments: { id: string };
    reason: string;
  }>;
  source_files: Array<{
    file_path: string;
    line_range: [number, number];
    action: "inspect_file";
    reason: string;
  }>;
  source_search: {
    tool: "search_source";
    arguments: {
      query: string;
      limit: number;
      max_content_chars: number;
      dependency_limit: number;
      include_impact: boolean;
      impact_limit: number;
    };
    reason: string;
  } | null;
  graph_health: {
    tool: "graph_health";
    arguments: Record<string, never>;
    reason: string;
  } | null;
}

export interface QueryContextResponse {
  ok: true;
  mode: QueryContextMode;
  question: string;
  budget?: QueryContextBudgetSummary;
  summary: QueryContextSummary;
  warnings: string[];
  next_steps: string[];
  expansion: QueryContextExpansion;
  graph: QueryResult & {
    staleness: StalenessReport;
    memory_quality: GraphMemoryQualitySummary;
  };
  source: {
    status: SourceIndexStatus;
    refreshed: boolean;
    search: SourceSearchResponse | null;
  };
  repo_map: QueryContextRepoMapSummary;
  related_nodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>;
}

const DEFAULT_GRAPH_LIMIT = 10;
const DEFAULT_SOURCE_LIMIT = 5;
const DEFAULT_DEPENDENCY_LIMIT = 3;
const DEFAULT_REFRESH_INDEX: SourceRefreshMode = "if_missing";
const DEFAULT_MODE: QueryContextMode = "standard";
const REPO_MAP_CAVEAT =
  "Repo map rankings are rebuildable source-index signals; use them to choose files to inspect, not as durable memory.";
const QUERY_CONTEXT_BUDGET_WARNING =
  "Query context was trimmed to stay within the configured byte budget.";
const TRUNCATION_MARKER = "\n... omitted for query_context budget ...";

const MODE_DEFAULTS: Record<
  QueryContextMode,
  {
    graphLimit: number;
    sourceLimit: number;
    maxContentChars?: number;
    dependencyLimit: number;
    includeImpact?: boolean;
    impactLimit: number;
  }
> = {
  compact: {
    graphLimit: 5,
    sourceLimit: 3,
    maxContentChars: 300,
    dependencyLimit: 0,
    includeImpact: false,
    impactLimit: 3,
  },
  standard: {
    graphLimit: DEFAULT_GRAPH_LIMIT,
    sourceLimit: DEFAULT_SOURCE_LIMIT,
    dependencyLimit: DEFAULT_DEPENDENCY_LIMIT,
    impactLimit: 5,
  },
  full: {
    graphLimit: 20,
    sourceLimit: 10,
    maxContentChars: 6000,
    dependencyLimit: 5,
    includeImpact: true,
    impactLimit: 8,
  },
};

export async function buildQueryContext(
  repoRoot: string,
  question: string,
  options: QueryContextOptions = {},
): Promise<QueryContextResponse> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("question must not be empty");
  }

  const mode = options.mode ?? DEFAULT_MODE;
  const defaults = MODE_DEFAULTS[mode];
  const graphLimit = options.graphLimit ?? defaults.graphLimit;
  const sourceLimit = options.sourceLimit ?? defaults.sourceLimit;
  const dependencyLimit = options.dependencyLimit ?? defaults.dependencyLimit;
  const refreshIndex = options.refreshIndex ?? DEFAULT_REFRESH_INDEX;
  const includeImpact =
    options.includeImpact ??
    defaults.includeImpact ??
    shouldIncludeImpact(trimmedQuestion);
  const impactLimit = options.impactLimit ?? defaults.impactLimit;
  const maxContentChars = options.maxContentChars ?? defaults.maxContentChars;
  const budgetBytes = options.budgetBytes;
  if (
    budgetBytes !== undefined &&
    (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0)
  ) {
    throw new Error("budgetBytes must be a positive integer");
  }
  const warnings: string[] = [];

  const store = await GraphStore.load(repoRoot);
  const graphCandidateLimit = Math.min(
    50,
    Math.max(graphLimit * 3, graphLimit + 10),
  );
  const graphCandidates = store.query(trimmedQuestion, graphCandidateLimit);
  const candidateStaleness = await checkSourceStaleness(
    repoRoot,
    graphCandidates.nodes,
  );
  const graphResult = rankGraphResultByQuality(
    graphCandidates,
    candidateStaleness,
    {
      limit: graphLimit,
      sourceChecksEnabled: true,
    },
  );
  const staleness = filterStalenessReportForNodes(
    candidateStaleness,
    graphResult.nodes,
    true,
  );
  const memoryQuality = summarizeGraphMemoryQuality(graphResult);
  if (graphResult.nodes.length > 0) {
    warnings.push(
      "Graph matches are curated repo memory; prefer fresh graph decisions/invariants/gotchas over re-deriving them.",
    );
  }
  if (staleness.stale_sources.length > 0) {
    warnings.push(
      "Some returned graph nodes have stale source anchors; re-read those files before relying on them.",
    );
  }
  if (memoryQuality.low_trust_node_ids.length > 0) {
    warnings.push(
      "Some graph nodes are low-trust; inspect their source anchors before relying on them.",
    );
  }

  let sourceStatus = await getSourceIndexStatus(repoRoot);
  let refreshed = false;
  const shouldRefresh =
    refreshIndex === "if_stale"
      ? !sourceStatus.indexed || !sourceStatus.fresh
      : refreshIndex === "if_missing" && !sourceStatus.indexed;

  if (shouldRefresh) {
    try {
      await scanSourceIndex(repoRoot);
      refreshed = true;
      sourceStatus = await getSourceIndexStatus(repoRoot);
    } catch (err) {
      warnings.push(`Source index refresh failed: ${String(err)}`);
    }
  }

  let sourceSearch: SourceSearchResponse | null = null;
  let sourceIndex: SourceIndex | null = null;
  let sourceIndexLoadError: unknown = null;
  if (sourceStatus.indexed) {
    try {
      sourceIndex = await loadSourceIndex(repoRoot);
    } catch (err) {
      sourceIndexLoadError = err;
    }
  }
  const repoMap = buildRepoMap(sourceIndex, {
    query: trimmedQuestion,
    fileLimit: Math.max(sourceLimit, 5),
    symbolLimit: 12,
  });
  if (sourceStatus.indexed && sourceStatus.fresh) {
    sourceSearch = sourceIndexLoadError
      ? {
          ok: false,
          query: trimmedQuestion,
          index_updated_at: sourceStatus.updated_at,
          search_time_ms: 0,
          total_results: 0,
          results: [],
          error: {
            code: "INDEX_INVALID",
            message: String(sourceIndexLoadError),
          },
        }
      : await searchSourceIndex(repoRoot, trimmedQuestion, {
          limit: sourceLimit,
          maxContentChars,
          dependencyLimit,
          includeImpact,
          impactLimit,
          sourceIndex: sourceIndex ?? undefined,
        });
    if (!sourceSearch.ok && sourceSearch.error) {
      warnings.push(`Source search failed: ${sourceSearch.error.message}`);
    } else if (sourceSearch.ok && sourceSearch.results.length > 0) {
      warnings.push(...(sourceSearch.warnings ?? []));
      warnings.push(
        "Source hits come from the rebuildable local index; treat them as discovery hints until you inspect the files.",
      );
      if (sourceSearch.results.some((result) => result.impact_context)) {
        warnings.push(
          "Impact context is bounded planning context; exact imports/importers are stronger than approximate text references.",
        );
      }
    }
    if (repoMap.files.length > 0) {
      warnings.push(REPO_MAP_CAVEAT);
    }
  } else if (!sourceStatus.indexed) {
    warnings.push(
      "Source index is missing; use refresh_index: if_missing or run index_codebase before source search.",
    );
  } else if (!sourceStatus.fresh) {
    warnings.push(
      "Source index is stale; use refresh_index: if_stale or run index_codebase before relying on source hits.",
    );
    if (repoMap.files.length > 0) {
      warnings.push(REPO_MAP_CAVEAT);
    }
  }

  const relatedNodes = dedupeRelatedNodes(sourceSearch);
  const next_steps = nextSteps({
    graphNodeCount: graphResult.nodes.length,
    sourceSearch,
    sourceStatus,
    staleGraphSources: staleness.stale_sources.length,
  });
  const summary = buildSummary({
    graphResult,
    relatedNodes,
    sourceSearch,
    sourceStatus,
    repoMap,
    refreshed,
    staleness,
    warnings,
  });
  const expansion = buildExpansion({
    dependencyLimit,
    graphResult,
    impactLimit,
    question: trimmedQuestion,
    sourceLimit,
    sourceSearch,
    staleness,
  });
  const repoMapSummary = summarizeRepoMap(repoMap);

  const response: QueryContextResponse = {
    ok: true,
    mode,
    question: trimmedQuestion,
    summary,
    warnings,
    next_steps,
    expansion,
    graph: { ...graphResult, staleness, memory_quality: memoryQuality },
    source: {
      status: sourceStatus,
      refreshed,
      search: sourceSearch,
    },
    repo_map: repoMapSummary,
    related_nodes: relatedNodes,
  };
  return budgetBytes === undefined
    ? response
    : fitQueryContextBudget(response, budgetBytes);
}

type QueryContextLaneCounts = Record<QueryContextBudgetLane, number>;

function fitQueryContextBudget(
  input: QueryContextResponse,
  budgetBytes: number,
): QueryContextResponse {
  const response = cloneQueryContextResponse(input);
  const originalCounts = queryContextLaneCounts(response);
  const omittedByBudget = zeroQueryContextLaneCounts();

  let budgeted = attachQueryContextBudget(
    response,
    budgetBytes,
    originalCounts,
    omittedByBudget,
  );
  if (budgeted.budget?.within_budget) return budgeted;

  for (const maxChars of [1800, 1200, 800, 500, 240, 120]) {
    omittedByBudget.source += trimSourceContent(response, maxChars);
    budgeted = attachQueryContextBudget(
      response,
      budgetBytes,
      originalCounts,
      omittedByBudget,
    );
    if (budgeted.budget?.within_budget) return budgeted;
  }

  omittedByBudget.source += clearSourceDependencyContext(response);
  budgeted = attachQueryContextBudget(
    response,
    budgetBytes,
    originalCounts,
    omittedByBudget,
  );
  if (budgeted.budget?.within_budget) return budgeted;

  omittedByBudget.source += clearSourceImpactContext(response);
  budgeted = attachQueryContextBudget(
    response,
    budgetBytes,
    originalCounts,
    omittedByBudget,
  );
  if (budgeted.budget?.within_budget) return budgeted;

  for (const [fileLimit, symbolLimit] of [
    [3, 5],
    [1, 3],
    [0, 0],
  ] as const) {
    omittedByBudget.repo_map += trimRepoMap(response, fileLimit, symbolLimit);
    budgeted = attachQueryContextBudget(
      response,
      budgetBytes,
      originalCounts,
      omittedByBudget,
    );
    if (budgeted.budget?.within_budget) return budgeted;
  }

  for (const limit of [5, 3, 1, 0]) {
    omittedByBudget.related_nodes += trimRelatedNodes(response, limit);
    budgeted = attachQueryContextBudget(
      response,
      budgetBytes,
      originalCounts,
      omittedByBudget,
    );
    if (budgeted.budget?.within_budget) return budgeted;
  }

  for (const [graphLimit, sourceLimit] of [
    [5, 5],
    [3, 3],
    [1, 1],
    [0, 0],
  ] as const) {
    omittedByBudget.expansion += trimExpansion(
      response,
      graphLimit,
      sourceLimit,
    );
    budgeted = attachQueryContextBudget(
      response,
      budgetBytes,
      originalCounts,
      omittedByBudget,
    );
    if (budgeted.budget?.within_budget) return budgeted;
  }

  omittedByBudget.graph += trimGraphMatchDetails(response);
  budgeted = attachQueryContextBudget(
    response,
    budgetBytes,
    originalCounts,
    omittedByBudget,
  );
  if (budgeted.budget?.within_budget) return budgeted;

  for (const maxChars of [1200, 800, 500, 240, 120]) {
    omittedByBudget.graph += trimGraphNodeSummaries(response, maxChars);
    budgeted = attachQueryContextBudget(
      response,
      budgetBytes,
      originalCounts,
      omittedByBudget,
    );
    if (budgeted.budget?.within_budget) return budgeted;
  }

  for (const sourceLimit of [3, 1, 0]) {
    omittedByBudget.graph += trimGraphNodeSources(response, sourceLimit);
    budgeted = attachQueryContextBudget(
      response,
      budgetBytes,
      originalCounts,
      omittedByBudget,
    );
    if (budgeted.budget?.within_budget) return budgeted;
  }

  for (const limit of [5, 3, 1, 0]) {
    omittedByBudget.source += trimSourceResults(response, limit);
    budgeted = attachQueryContextBudget(
      response,
      budgetBytes,
      originalCounts,
      omittedByBudget,
    );
    if (budgeted.budget?.within_budget) return budgeted;
  }

  for (const limit of [5, 3, 1, 0]) {
    omittedByBudget.graph += trimGraphNodes(response, limit);
    budgeted = attachQueryContextBudget(
      response,
      budgetBytes,
      originalCounts,
      omittedByBudget,
    );
    if (budgeted.budget?.within_budget) return budgeted;
  }

  return attachQueryContextBudget(
    response,
    budgetBytes,
    originalCounts,
    omittedByBudget,
  );
}

function cloneQueryContextResponse(
  response: QueryContextResponse,
): QueryContextResponse {
  return JSON.parse(JSON.stringify(response)) as QueryContextResponse;
}

function attachQueryContextBudget(
  response: QueryContextResponse,
  budgetBytes: number,
  originalCounts: QueryContextLaneCounts,
  omittedByBudget: QueryContextLaneCounts,
): QueryContextResponse {
  if (hasLaneOmissions(omittedByBudget)) {
    addWarning(response, QUERY_CONTEXT_BUDGET_WARNING);
  }
  syncQueryContextSummary(response);
  response.budget = {
    budget_bytes: budgetBytes,
    used_bytes: 0,
    remaining_bytes: budgetBytes,
    within_budget: true,
    truncated:
      hasLaneOmissions(omittedByBudget) ||
      queryContextBudgetLanes().some(
        (lane) => queryContextLaneCounts(response)[lane] < originalCounts[lane],
      ),
    packing: queryContextPackingSummary(
      response,
      originalCounts,
      omittedByBudget,
    ),
  };
  return finalizeQueryContextBudget(response);
}

function finalizeQueryContextBudget(
  response: QueryContextResponse,
): QueryContextResponse {
  let next = response;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const used = responseBytes(next);
    const updated: QueryContextResponse = {
      ...next,
      budget: next.budget
        ? {
            ...next.budget,
            used_bytes: used,
            remaining_bytes: Math.max(0, next.budget.budget_bytes - used),
            within_budget: used <= next.budget.budget_bytes,
          }
        : undefined,
    };
    if (responseBytes(updated) === used) return updated;
    next = updated;
  }
  const used = responseBytes(next);
  return {
    ...next,
    budget: next.budget
      ? {
          ...next.budget,
          used_bytes: used,
          remaining_bytes: Math.max(0, next.budget.budget_bytes - used),
          within_budget: used <= next.budget.budget_bytes,
        }
      : undefined,
  };
}

function queryContextPackingSummary(
  response: QueryContextResponse,
  originalCounts: QueryContextLaneCounts,
  omittedByBudget: QueryContextLaneCounts,
): QueryContextPackingSummary {
  const currentCounts = queryContextLaneCounts(response);
  const lanes: Partial<
    Record<QueryContextBudgetLane, QueryContextPackingLaneStats>
  > = {};
  for (const lane of queryContextBudgetLanes()) {
    const selected = currentCounts[lane];
    const candidates = Math.max(originalCounts[lane], selected);
    const omitted = Math.max(0, originalCounts[lane] - selected);
    if (candidates > 0 || omittedByBudget[lane] > 0) {
      lanes[lane] = {
        candidates,
        selected,
        omitted,
        omitted_by_budget: omittedByBudget[lane],
        used_bytes: responseBytes(queryContextLanePayload(response, lane)),
      };
    }
  }
  return {
    strategy: "planning_detail_budget_v1",
    lanes,
  };
}

function queryContextLanePayload(
  response: QueryContextResponse,
  lane: QueryContextBudgetLane,
): unknown {
  switch (lane) {
    case "summary":
      return response.summary;
    case "graph":
      return response.graph;
    case "source":
      return response.source;
    case "repo_map":
      return response.repo_map;
    case "related_nodes":
      return response.related_nodes;
    case "expansion":
      return response.expansion;
    case "warnings":
      return response.warnings;
  }
}

function queryContextLaneCounts(
  response: QueryContextResponse,
): QueryContextLaneCounts {
  return {
    summary: 1,
    graph: response.graph.nodes.length,
    source: sourceResults(response).length,
    repo_map: response.repo_map.files.length + response.repo_map.symbols.length,
    related_nodes: response.related_nodes.length,
    expansion:
      response.expansion.graph_nodes.length +
      response.expansion.source_files.length +
      (response.expansion.source_search ? 1 : 0) +
      (response.expansion.graph_health ? 1 : 0),
    warnings: response.warnings.length,
  };
}

function zeroQueryContextLaneCounts(): QueryContextLaneCounts {
  return {
    summary: 0,
    graph: 0,
    source: 0,
    repo_map: 0,
    related_nodes: 0,
    expansion: 0,
    warnings: 0,
  };
}

function queryContextBudgetLanes(): QueryContextBudgetLane[] {
  return [
    "summary",
    "graph",
    "source",
    "repo_map",
    "related_nodes",
    "expansion",
    "warnings",
  ];
}

function hasLaneOmissions(counts: QueryContextLaneCounts): boolean {
  return queryContextBudgetLanes().some((lane) => counts[lane] > 0);
}

function sourceResults(
  response: QueryContextResponse,
): SourceSearchResponse["results"] {
  return response.source.search?.ok ? response.source.search.results : [];
}

function trimSourceContent(
  response: QueryContextResponse,
  maxChars: number,
): number {
  let changed = 0;
  for (const result of sourceResults(response)) {
    const trimmed = truncateBudgetText(result.content, maxChars);
    if (trimmed !== result.content) {
      result.content = trimmed;
      changed += 1;
    }
  }
  if (changed > 0) syncQueryContextSummary(response);
  return changed;
}

function clearSourceDependencyContext(response: QueryContextResponse): number {
  let changed = 0;
  for (const result of sourceResults(response)) {
    if (result.dependency_context.length > 0) {
      result.dependency_context = [];
      changed += 1;
    }
  }
  if (changed > 0) syncQueryContextSummary(response);
  return changed;
}

function clearSourceImpactContext(response: QueryContextResponse): number {
  let changed = 0;
  for (const result of sourceResults(response)) {
    if (result.impact_context !== undefined) {
      delete result.impact_context;
      changed += 1;
    }
  }
  if (changed > 0) syncQueryContextSummary(response);
  return changed;
}

function trimRepoMap(
  response: QueryContextResponse,
  fileLimit: number,
  symbolLimit: number,
): number {
  const omittedFiles = Math.max(0, response.repo_map.files.length - fileLimit);
  const omittedSymbols = Math.max(
    0,
    response.repo_map.symbols.length - symbolLimit,
  );
  response.repo_map = {
    ...response.repo_map,
    files: response.repo_map.files.slice(0, fileLimit),
    symbols: response.repo_map.symbols.slice(0, symbolLimit),
  };
  syncQueryContextSummary(response);
  return omittedFiles + omittedSymbols;
}

function trimRelatedNodes(
  response: QueryContextResponse,
  limit: number,
): number {
  const omitted = Math.max(0, response.related_nodes.length - limit);
  if (omitted > 0) {
    response.related_nodes = response.related_nodes.slice(0, limit);
    syncQueryContextSummary(response);
  }
  return omitted;
}

function trimExpansion(
  response: QueryContextResponse,
  graphLimit: number,
  sourceFileLimit: number,
): number {
  const omittedGraph = Math.max(
    0,
    response.expansion.graph_nodes.length - graphLimit,
  );
  const omittedSource = Math.max(
    0,
    response.expansion.source_files.length - sourceFileLimit,
  );
  if (omittedGraph > 0 || omittedSource > 0) {
    response.expansion = {
      ...response.expansion,
      graph_nodes: response.expansion.graph_nodes.slice(0, graphLimit),
      source_files: response.expansion.source_files.slice(0, sourceFileLimit),
    };
    syncQueryContextSummary(response);
  }
  return omittedGraph + omittedSource;
}

function trimGraphMatchDetails(response: QueryContextResponse): number {
  let changed = 0;
  for (const match of response.graph.matches) {
    if (match.match_reasons.length > 1) {
      match.match_reasons = match.match_reasons.slice(0, 1);
      changed += 1;
    }
    if (match.quality?.reasons && match.quality.reasons.length > 1) {
      match.quality.reasons = match.quality.reasons.slice(0, 1);
      changed += 1;
    }
  }
  return changed;
}

function trimGraphNodeSummaries(
  response: QueryContextResponse,
  maxChars: number,
): number {
  let changed = 0;
  for (const node of response.graph.nodes) {
    const trimmed = truncateBudgetText(node.summary, maxChars);
    if (trimmed !== node.summary) {
      node.summary = trimmed;
      changed += 1;
    }
  }
  if (changed > 0) syncQueryContextSummary(response);
  return changed;
}

function trimGraphNodeSources(
  response: QueryContextResponse,
  sourceLimit: number,
): number {
  let omitted = 0;
  for (const node of response.graph.nodes) {
    omitted += Math.max(0, node.sources.length - sourceLimit);
    node.sources = node.sources.slice(0, sourceLimit);
  }
  if (omitted > 0) {
    syncGraphNodeDependents(response);
    syncQueryContextSummary(response);
  }
  return omitted;
}

function trimGraphNodes(
  response: QueryContextResponse,
  limit: number,
): number {
  const omitted = Math.max(0, response.graph.nodes.length - limit);
  if (omitted > 0) {
    response.graph.nodes = response.graph.nodes.slice(0, limit);
    syncGraphNodeDependents(response);
    syncQueryContextSummary(response);
  }
  return omitted;
}

function trimSourceResults(
  response: QueryContextResponse,
  limit: number,
): number {
  const search = response.source.search;
  if (!search?.ok) return 0;
  const omitted = Math.max(0, search.results.length - limit);
  if (omitted > 0) {
    const relatedNodeLimit = response.related_nodes.length;
    search.results = search.results.slice(0, limit);
    response.related_nodes = dedupeRelatedNodes(search).slice(0, relatedNodeLimit);
    response.expansion = {
      ...response.expansion,
      source_files: response.expansion.source_files.slice(0, limit),
    };
    syncQueryContextSummary(response);
  }
  return omitted;
}

function syncGraphNodeDependents(response: QueryContextResponse): void {
  const graphNodeIds = new Set(response.graph.nodes.map((node) => node.id));
  response.graph.matches = response.graph.matches.filter((match) =>
    graphNodeIds.has(match.node_id),
  );
  response.graph.edges = response.graph.edges.filter(
    (edge) => graphNodeIds.has(edge.from) && graphNodeIds.has(edge.to),
  );
  response.graph.staleness = filterStalenessReportForNodes(
    response.graph.staleness,
    response.graph.nodes,
    true,
  );
  response.graph.staleness = filterStalenessReportForRetainedSources(
    response.graph.staleness,
    response.graph.nodes,
  );
  response.graph.memory_quality = summarizeGraphMemoryQuality(response.graph);
  response.expansion = {
    ...response.expansion,
    graph_nodes: response.expansion.graph_nodes.filter((entry) =>
      graphNodeIds.has(entry.id),
    ),
  };
}

function filterStalenessReportForRetainedSources(
  staleness: StalenessReport,
  nodes: Node[],
): StalenessReport {
  const retainedSources = new Set(
    nodes.flatMap((node) =>
      node.sources.map(
        (source) => `${node.id}\0${source.file_path}\0${source.content_hash}`,
      ),
    ),
  );
  const stale_sources = staleness.stale_sources.filter((source) =>
    retainedSources.has(
      `${source.node_id}\0${source.file_path}\0${source.stored_hash}`,
    ),
  );
  const range_fresh_sources = staleness.range_fresh_sources.filter((source) =>
    retainedSources.has(
      `${source.node_id}\0${source.file_path}\0${source.stored_hash}`,
    ),
  );
  return {
    checked_sources: stale_sources.length + range_fresh_sources.length,
    stale_sources,
    range_fresh_sources,
  };
}

function truncateBudgetText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length + 20) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function addWarning(response: QueryContextResponse, warning: string): void {
  if (!response.warnings.includes(warning)) response.warnings.push(warning);
}

function syncQueryContextSummary(response: QueryContextResponse): void {
  const currentSourceResults = sourceResults(response);
  response.summary.graph_memories = summarizeGraphMemories(response.graph);
  response.summary.source_hits = currentSourceResults.slice(0, 5).map((result) => ({
    file_path: result.file_path,
    start_line: result.start_line,
    end_line: result.end_line,
    chunk_type: result.chunk_type,
    score: result.score,
    matched_symbols: result.symbols.slice(0, 3).map((symbol) => symbol.name),
    match_reasons: result.match_reasons
      .slice(0, 3)
      .map((reason) => `${reason.field}:${reason.value}`),
    has_dependency_context: result.dependency_context.length > 0,
    has_impact_context: result.impact_context !== undefined,
  }));
  response.summary.repo_map = response.repo_map;
  response.summary.totals = {
    ...response.summary.totals,
    graph_nodes: response.graph.nodes.length,
    related_nodes: response.related_nodes.length,
    repo_map_files: response.repo_map.summary.files,
    source_results: currentSourceResults.length,
    stale_graph_sources: response.graph.staleness.stale_sources.length,
    warnings: response.warnings.length,
  };
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function summarizeGraphMemories(
  graphResult: QueryResult,
): QueryContextGraphMemorySummary[] {
  const matchesById = new Map(
    graphResult.matches.map((match) => [match.node_id, match]),
  );
  return graphResult.nodes.slice(0, 5).map((node) => {
    const match = matchesById.get(node.id);
    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      trust: match?.quality?.trust,
      freshness: match?.quality?.freshness,
      score: match?.score,
      ranking_score: match?.ranking_score,
      match_reasons: (match?.match_reasons ?? []).slice(0, 3).map(
        (reason) => `${reason.field}:${reason.value}`,
      ),
      quality_reasons: match?.quality?.reasons.slice(0, 3) ?? [],
      quality_signals: match?.quality?.signals,
    };
  });
}

function buildSummary(input: {
  graphResult: QueryResult;
  relatedNodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>;
  sourceSearch: SourceSearchResponse | null;
  sourceStatus: SourceIndexStatus;
  repoMap: ReturnType<typeof buildRepoMap>;
  refreshed: boolean;
  staleness: StalenessReport;
  warnings: string[];
}): QueryContextSummary {
  const sourceResults =
    input.sourceSearch?.ok === true ? input.sourceSearch.results : [];

  return {
    graph_memories: summarizeGraphMemories(input.graphResult),
    source_hits: sourceResults.slice(0, 5).map((result) => ({
      file_path: result.file_path,
      start_line: result.start_line,
      end_line: result.end_line,
      chunk_type: result.chunk_type,
      score: result.score,
      matched_symbols: result.symbols.slice(0, 3).map((symbol) => symbol.name),
      match_reasons: result.match_reasons
        .slice(0, 3)
        .map((reason) => `${reason.field}:${reason.value}`),
      has_dependency_context: result.dependency_context.length > 0,
      has_impact_context: result.impact_context !== undefined,
    })),
    repo_map: summarizeRepoMap(input.repoMap),
    source_index: {
      indexed: input.sourceStatus.indexed,
      fresh: input.sourceStatus.fresh,
      refreshed: input.refreshed,
      files_indexed: input.sourceStatus.files_indexed,
      chunks_indexed: input.sourceStatus.chunks_indexed,
      symbols_indexed: input.sourceStatus.symbols_indexed,
      stale_files: input.sourceStatus.stale_files,
      missing_files: input.sourceStatus.missing_files,
      new_files: input.sourceStatus.new_files,
    },
    totals: {
      graph_nodes: input.graphResult.nodes.length,
      related_nodes: input.relatedNodes.length,
      repo_map_files: input.repoMap.summary.files,
      source_results: sourceResults.length,
      stale_graph_sources: input.staleness.stale_sources.length,
      warnings: input.warnings.length,
    },
  };
}

function summarizeRepoMap(
  repoMap: ReturnType<typeof buildRepoMap>,
): QueryContextRepoMapSummary {
  return {
    summary: repoMap.summary,
    files: repoMap.files.slice(0, 5).map(repoMapFileSummary),
    symbols: repoMap.symbols.slice(0, 8),
  };
}

function buildExpansion(input: {
  dependencyLimit: number;
  graphResult: QueryResult;
  impactLimit: number;
  question: string;
  sourceLimit: number;
  sourceSearch: SourceSearchResponse | null;
  staleness: StalenessReport;
}): QueryContextExpansion {
  const sourceResults =
    input.sourceSearch?.ok === true ? input.sourceSearch.results : [];

  return {
    graph_nodes: input.graphResult.nodes.map((node) => ({
      id: node.id,
      tool: "get_node",
      arguments: { id: node.id },
      reason: "Fetch the full curated memory before relying on it.",
    })),
    source_files: sourceResults.map((result) => ({
      file_path: result.file_path,
      line_range: [result.start_line, result.end_line],
      action: "inspect_file",
      reason:
        "Inspect the real file range before treating the indexed hit as evidence.",
    })),
    source_search:
      sourceResults.length > 0
        ? {
            tool: "search_source",
            arguments: {
              query: input.question,
              limit: Math.max(input.sourceLimit, 10),
              max_content_chars: 6000,
              dependency_limit: Math.max(input.dependencyLimit, 3),
              include_impact: true,
              impact_limit: Math.max(input.impactLimit, 5),
            },
            reason:
              "Expand source results with larger previews, dependency context, and impact context if the compact/standard hit is insufficient.",
          }
        : null,
    graph_health:
      input.staleness.stale_sources.length > 0
        ? {
            tool: "graph_health",
            arguments: {},
            reason:
              "Inspect graph health before relying on stale or suspicious graph memory.",
          }
        : null,
  };
}

function shouldIncludeImpact(question: string): boolean {
  return question
    .split(/\s+/)
    .some((token) =>
      /[./\\]/.test(token) ||
      /[a-z0-9_$][A-Z][A-Za-z0-9_$]*/.test(token) ||
      /[$]/.test(token) ||
      /^[A-Za-z_$][A-Za-z0-9$]*(?:_[A-Za-z0-9$]+){2,}$/.test(token) ||
      /\(\)$/.test(token),
    );
}

function dedupeRelatedNodes(
  sourceSearch: SourceSearchResponse | null,
): Array<Pick<Node, "id" | "kind" | "name" | "summary">> {
  const byId = new Map<
    string,
    Pick<Node, "id" | "kind" | "name" | "summary">
  >();
  for (const result of sourceSearch?.results ?? []) {
    for (const node of result.related_nodes) {
      if (!byId.has(node.id)) {
        byId.set(node.id, node);
      }
    }
  }
  return [...byId.values()];
}

function nextSteps(input: {
  graphNodeCount: number;
  sourceSearch: SourceSearchResponse | null;
  sourceStatus: SourceIndexStatus;
  staleGraphSources: number;
}): string[] {
  const steps: string[] = [];

  if (input.staleGraphSources > 0) {
    steps.push("Inspect stale graph source files before trusting those nodes.");
  }
  if (!input.sourceStatus.indexed) {
    steps.push("Build the source index for code discovery.");
  } else if (!input.sourceStatus.fresh) {
    steps.push("Refresh the source index before relying on source hits.");
  }
  if (input.sourceSearch?.ok && input.sourceSearch.results.length > 0) {
    steps.push("Inspect the returned source files before emitting durable graph findings.");
  }
  if (
    input.graphNodeCount === 0 &&
    (!input.sourceSearch?.ok || input.sourceSearch.results.length === 0)
  ) {
    steps.push("No context hits were found; fall back to direct file search, then emit durable repo-local findings if you learn something non-obvious.");
  }
  if (steps.length === 0) {
    steps.push("Use the returned graph and source context to plan, then emit only durable repo-local knowledge.");
  }

  return steps;
}
