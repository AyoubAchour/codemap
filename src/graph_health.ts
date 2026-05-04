import { GraphStore } from "./graph.js";
import {
  checkSourceStaleness,
  type StaleSource,
  type StalenessReport,
} from "./staleness.js";
import type { Node } from "./types.js";
import type { ValidationIssue, ValidationResult } from "./validator.js";

export interface GraphHealthOptions {
  includeDeprecated?: boolean;
  issueLimit?: number;
}

export interface GraphHealthOkResponse {
  ok: true;
  summary: {
    total_nodes: number;
    active_nodes: number;
    deprecated_nodes: number;
    checked_nodes: number;
    total_edges: number;
    checked_sources: number;
    stale_sources: number;
    changed_sources: number;
    missing_sources: number;
    unsafe_sources: number;
    read_errors: number;
    duplicate_aliases: number;
    validator_repairs: number;
    validator_errors: number;
    issue_limit: number;
    reported_stale_sources: number;
    truncated_stale_sources: boolean;
    fresh: boolean;
  };
  validation: ValidationResult;
  staleness: StalenessReport;
  issues: {
    duplicate_aliases: Array<Extract<ValidationIssue, { kind: "duplicate_alias" }>>;
    stale_sources: StaleSource[];
    changed_sources: StaleSource[];
    missing_sources: StaleSource[];
    unsafe_sources: StaleSource[];
    read_errors: StaleSource[];
    repairs: ValidationIssue[];
    errors: ValidationIssue[];
  };
  suggestions: string[];
}

export interface GraphHealthErrorResponse {
  ok: false;
  error: {
    code: "GRAPH_HEALTH_FAILED";
    message: string;
  };
}

export type GraphHealthResponse = GraphHealthOkResponse | GraphHealthErrorResponse;

export async function inspectGraphHealth(
  repoRoot: string,
  options: GraphHealthOptions = {},
): Promise<GraphHealthResponse> {
  try {
    const store = await GraphStore.load(repoRoot);
    const issueLimit = options.issueLimit ?? 50;
    const graph = store._data();
    const validation = store.validationResult() ?? {
      ok: true,
      errors: [],
      warnings: [],
      repairs: [],
    };
    const allNodes = Object.entries(graph.nodes).map(
      ([id, node]) => ({ id, ...node }) satisfies Node,
    );
    const checkedNodes = options.includeDeprecated
      ? allNodes
      : allNodes.filter((node) => node.status !== "deprecated");
    const staleness = await checkSourceStaleness(repoRoot, checkedNodes);
    const staleSources = staleness.stale_sources;
    const duplicateAliases = validation.warnings.filter(
      (issue): issue is Extract<ValidationIssue, { kind: "duplicate_alias" }> =>
        issue.kind === "duplicate_alias",
    );
    const changedSources = staleSources.filter(
      (source) => source.reason === "changed",
    );
    const missingSources = staleSources.filter(
      (source) => source.reason === "missing",
    );
    const unsafeSources = staleSources.filter(
      (source) => source.reason === "unsafe_path",
    );
    const readErrors = staleSources.filter(
      (source) => source.reason === "read_error",
    );
    const reportedStaleSources = staleSources.slice(0, issueLimit);
    const reportedChangedSources = reportedStaleSources.filter(
      (source) => source.reason === "changed",
    );
    const reportedMissingSources = reportedStaleSources.filter(
      (source) => source.reason === "missing",
    );
    const reportedUnsafeSources = reportedStaleSources.filter(
      (source) => source.reason === "unsafe_path",
    );
    const reportedReadErrors = reportedStaleSources.filter(
      (source) => source.reason === "read_error",
    );
    const activeNodes = allNodes.filter((node) => node.status === "active").length;
    const deprecatedNodes = allNodes.length - activeNodes;
    const fresh =
      validation.ok &&
      validation.errors.length === 0 &&
      validation.warnings.length === 0 &&
      validation.repairs.length === 0 &&
      staleSources.length === 0;

    return {
      ok: true,
      summary: {
        total_nodes: allNodes.length,
        active_nodes: activeNodes,
        deprecated_nodes: deprecatedNodes,
        checked_nodes: checkedNodes.length,
        total_edges: Object.keys(graph.edges).length,
        checked_sources: staleness.checked_sources,
        stale_sources: staleSources.length,
        changed_sources: changedSources.length,
        missing_sources: missingSources.length,
        unsafe_sources: unsafeSources.length,
        read_errors: readErrors.length,
        duplicate_aliases: duplicateAliases.length,
        validator_repairs: validation.repairs.length,
        validator_errors: validation.errors.length,
        issue_limit: issueLimit,
        reported_stale_sources: Math.min(staleSources.length, issueLimit),
        truncated_stale_sources: staleSources.length > issueLimit,
        fresh,
      },
      validation,
      staleness: {
        checked_sources: staleness.checked_sources,
        stale_sources: reportedStaleSources,
      },
      issues: {
        duplicate_aliases: duplicateAliases,
        stale_sources: reportedStaleSources,
        changed_sources: reportedChangedSources,
        missing_sources: reportedMissingSources,
        unsafe_sources: reportedUnsafeSources,
        read_errors: reportedReadErrors,
        repairs: validation.repairs,
        errors: validation.errors,
      },
      suggestions: buildSuggestions({
        duplicateAliases,
        changedSources,
        missingSources,
        unsafeSources,
        readErrors,
        repairs: validation.repairs,
        errors: validation.errors,
        fresh,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "GRAPH_HEALTH_FAILED",
        message: String(err),
      },
    };
  }
}

function buildSuggestions(input: {
  duplicateAliases: Array<Extract<ValidationIssue, { kind: "duplicate_alias" }>>;
  changedSources: StaleSource[];
  missingSources: StaleSource[];
  unsafeSources: StaleSource[];
  readErrors: StaleSource[];
  repairs: ValidationIssue[];
  errors: ValidationIssue[];
  fresh: boolean;
}): string[] {
  if (input.fresh) return ["Graph health is clean."];

  const suggestions: string[] = [];
  if (input.duplicateAliases.length > 0) {
    suggestions.push(
      "Resolve duplicate aliases with codemap correct <id> --remove-alias <alias>.",
    );
  }
  if (input.changedSources.length > 0) {
    suggestions.push(
      "Re-read changed source files before trusting affected nodes; refresh durable findings with emit_node merge_with when needed.",
    );
  }
  if (input.missingSources.length > 0) {
    suggestions.push(
      "For missing source anchors, deprecate removed knowledge or re-anchor nodes to replacement repo files.",
    );
  }
  if (input.unsafeSources.length > 0) {
    suggestions.push(
      "Replace unsafe source anchors with repo-relative file paths before relying on those nodes.",
    );
  }
  if (input.readErrors.length > 0) {
    suggestions.push(
      "Inspect read errors on source anchors; they may indicate permissions or transient filesystem issues.",
    );
  }
  if (input.repairs.length > 0) {
    suggestions.push(
      "Run codemap validate to inspect auto-repairable graph issues before the next write persists repairs.",
    );
  }
  if (input.errors.length > 0) {
    suggestions.push(
      "Fix schema-level graph errors before using graph memory for planning.",
    );
  }
  if (suggestions.length === 0) {
    suggestions.push(
      "Inspect validator output for graph health issues that do not yet have a specialized suggestion.",
    );
  }

  return suggestions;
}
