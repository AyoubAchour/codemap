import { GraphStore, type QueryResult } from "./graph.js";
import {
  filterStalenessReportForNodes,
  rankGraphResultByQuality,
  summarizeGraphMemoryQuality,
  type GraphMemoryQualitySummary,
} from "./graph_quality.js";
import { checkSourceStaleness, type StalenessReport } from "./staleness.js";
import {
  getSourceIndexStatus,
  scanSourceIndex,
  searchSourceIndex,
  type SourceIndexStatus,
  type SourceSearchResponse,
} from "./source_index.js";
import type { Node } from "./types.js";

export type SourceRefreshMode = "never" | "if_missing" | "if_stale";
export type QueryContextMode = "compact" | "standard" | "full";

export interface QueryContextOptions {
  mode?: QueryContextMode;
  graphLimit?: number;
  sourceLimit?: number;
  maxContentChars?: number;
  dependencyLimit?: number;
  refreshIndex?: SourceRefreshMode;
  includeImpact?: boolean;
  impactLimit?: number;
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

export interface QueryContextSummary {
  graph_memories: QueryContextGraphMemorySummary[];
  source_hits: QueryContextSourceHitSummary[];
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
  related_nodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>;
}

const DEFAULT_GRAPH_LIMIT = 10;
const DEFAULT_SOURCE_LIMIT = 5;
const DEFAULT_DEPENDENCY_LIMIT = 3;
const DEFAULT_REFRESH_INDEX: SourceRefreshMode = "if_missing";
const DEFAULT_MODE: QueryContextMode = "standard";

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
  if (sourceStatus.indexed && sourceStatus.fresh) {
    sourceSearch = await searchSourceIndex(repoRoot, trimmedQuestion, {
      limit: sourceLimit,
      maxContentChars,
      dependencyLimit,
      includeImpact,
      impactLimit,
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
  } else if (!sourceStatus.indexed) {
    warnings.push(
      "Source index is missing; use refresh_index: if_missing or run index_codebase before source search.",
    );
  } else if (!sourceStatus.fresh) {
    warnings.push(
      "Source index is stale; use refresh_index: if_stale or run index_codebase before relying on source hits.",
    );
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

  return {
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
    related_nodes: relatedNodes,
  };
}

function buildSummary(input: {
  graphResult: QueryResult;
  relatedNodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>;
  sourceSearch: SourceSearchResponse | null;
  sourceStatus: SourceIndexStatus;
  refreshed: boolean;
  staleness: StalenessReport;
  warnings: string[];
}): QueryContextSummary {
  const matchesById = new Map(
    input.graphResult.matches.map((match) => [match.node_id, match]),
  );
  const sourceResults =
    input.sourceSearch?.ok === true ? input.sourceSearch.results : [];

  return {
    graph_memories: input.graphResult.nodes.slice(0, 5).map((node) => {
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
      };
    }),
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
      source_results: sourceResults.length,
      stale_graph_sources: input.staleness.stale_sources.length,
      warnings: input.warnings.length,
    },
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
