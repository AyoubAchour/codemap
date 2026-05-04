import { GraphStore, type QueryResult } from "./graph.js";
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

export interface QueryContextOptions {
  graphLimit?: number;
  sourceLimit?: number;
  maxContentChars?: number;
  refreshIndex?: SourceRefreshMode;
}

export interface QueryContextResponse {
  ok: true;
  question: string;
  graph: QueryResult & { staleness: StalenessReport };
  source: {
    status: SourceIndexStatus;
    refreshed: boolean;
    search: SourceSearchResponse | null;
  };
  related_nodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>;
  warnings: string[];
  next_steps: string[];
}

const DEFAULT_GRAPH_LIMIT = 10;
const DEFAULT_SOURCE_LIMIT = 5;
const DEFAULT_REFRESH_INDEX: SourceRefreshMode = "if_missing";

export async function buildQueryContext(
  repoRoot: string,
  question: string,
  options: QueryContextOptions = {},
): Promise<QueryContextResponse> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("question must not be empty");
  }

  const graphLimit = options.graphLimit ?? DEFAULT_GRAPH_LIMIT;
  const sourceLimit = options.sourceLimit ?? DEFAULT_SOURCE_LIMIT;
  const refreshIndex = options.refreshIndex ?? DEFAULT_REFRESH_INDEX;
  const warnings: string[] = [];

  const store = await GraphStore.load(repoRoot);
  const graphResult = store.query(trimmedQuestion, graphLimit);
  const staleness = await checkSourceStaleness(repoRoot, graphResult.nodes);
  if (staleness.stale_sources.length > 0) {
    warnings.push(
      "Some returned graph nodes have stale source anchors; re-read those files before relying on them.",
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
      maxContentChars: options.maxContentChars,
    });
    if (!sourceSearch.ok && sourceSearch.error) {
      warnings.push(`Source search failed: ${sourceSearch.error.message}`);
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

  return {
    ok: true,
    question: trimmedQuestion,
    graph: { ...graphResult, staleness },
    source: {
      status: sourceStatus,
      refreshed,
      search: sourceSearch,
    },
    related_nodes: relatedNodes,
    warnings,
    next_steps: nextSteps({
      graphNodeCount: graphResult.nodes.length,
      sourceSearch,
      sourceStatus,
      staleGraphSources: staleness.stale_sources.length,
    }),
  };
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
