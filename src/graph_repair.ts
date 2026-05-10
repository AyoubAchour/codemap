import { promises as fs } from "node:fs";

import { GraphStore } from "./graph.js";
import { hashBuffer, hashSourceRange, safeRepoPath } from "./staleness.js";
import type { Node, SourceRef } from "./types.js";

export type GraphRepairReason =
  | "range_unchanged"
  | "anchor_changed"
  | "changed"
  | "missing"
  | "unsafe_path"
  | "read_error";

export type GraphRepairAction =
  | "refresh_range_anchor"
  | "review_and_merge"
  | "reanchor_legacy_source"
  | "deprecate_or_reanchor"
  | "fix_unsafe_path"
  | "inspect_read_error";

export interface GraphRepairOptions {
  includeDeprecated?: boolean;
  issueLimit?: number;
}

export interface GraphRepairProposal {
  node_id: string;
  node_name: string;
  source_index: number;
  file_path: string;
  line_range: [number, number];
  stored_hash: string;
  current_hash?: string;
  stored_range_hash?: string;
  current_range_hash?: string;
  reason: GraphRepairReason;
  action: GraphRepairAction;
  legacy: boolean;
  replacement_source?: SourceRef;
  explanation: string;
}

export interface GraphRepairOkResponse {
  ok: true;
  summary: {
    checked_nodes: number;
    checked_sources: number;
    proposals: number;
    range_refreshes: number;
    anchor_reviews: number;
    legacy_anchors: number;
    missing_sources: number;
    unsafe_sources: number;
    read_errors: number;
    issue_limit: number;
    reported_proposals: number;
    truncated_proposals: boolean;
    clean: boolean;
  };
  proposals: GraphRepairProposal[];
  suggestions: string[];
}

export interface GraphRepairErrorResponse {
  ok: false;
  error: {
    code: "GRAPH_REPAIR_FAILED";
    message: string;
  };
}

export type GraphRepairResponse =
  | GraphRepairOkResponse
  | GraphRepairErrorResponse;

export async function inspectGraphRepair(
  repoRoot: string,
  options: GraphRepairOptions = {},
): Promise<GraphRepairResponse> {
  try {
    const store = await GraphStore.load(repoRoot);
    const issueLimit = options.issueLimit ?? 50;
    const graph = store._data();
    const allNodes = Object.entries(graph.nodes)
      .map(([id, node]) => ({ id, ...node }) satisfies Node)
      .sort((a, b) => a.id.localeCompare(b.id));
    const checkedNodes = options.includeDeprecated
      ? allNodes
      : allNodes.filter((node) => node.status !== "deprecated");

    const proposals: GraphRepairProposal[] = [];
    let checkedSources = 0;
    for (const node of checkedNodes) {
      for (const [sourceIndex, source] of node.sources.entries()) {
        checkedSources += 1;
        const proposal = await inspectSourceAnchor({
          repoRoot,
          node,
          source,
          sourceIndex,
        });
        if (proposal) proposals.push(proposal);
      }
    }

    const reportedProposals = proposals.slice(0, issueLimit);
    const rangeRefreshes = proposals.filter(
      (proposal) => proposal.action === "refresh_range_anchor",
    ).length;
    const anchorReviews = proposals.filter(
      (proposal) => proposal.action === "review_and_merge",
    ).length;
    const legacyAnchors = proposals.filter(
      (proposal) => proposal.action === "reanchor_legacy_source",
    ).length;
    const missingSources = proposals.filter(
      (proposal) => proposal.reason === "missing",
    ).length;
    const unsafeSources = proposals.filter(
      (proposal) => proposal.reason === "unsafe_path",
    ).length;
    const readErrors = proposals.filter(
      (proposal) => proposal.reason === "read_error",
    ).length;

    return {
      ok: true,
      summary: {
        checked_nodes: checkedNodes.length,
        checked_sources: checkedSources,
        proposals: proposals.length,
        range_refreshes: rangeRefreshes,
        anchor_reviews: anchorReviews,
        legacy_anchors: legacyAnchors,
        missing_sources: missingSources,
        unsafe_sources: unsafeSources,
        read_errors: readErrors,
        issue_limit: issueLimit,
        reported_proposals: Math.min(proposals.length, issueLimit),
        truncated_proposals: proposals.length > issueLimit,
        clean: proposals.length === 0,
      },
      proposals: reportedProposals,
      suggestions: buildSuggestions({
        proposals,
        rangeRefreshes,
        anchorReviews,
        legacyAnchors,
        missingSources,
        unsafeSources,
        readErrors,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "GRAPH_REPAIR_FAILED",
        message: String(err),
      },
    };
  }
}

async function inspectSourceAnchor(input: {
  repoRoot: string;
  node: Node;
  source: SourceRef;
  sourceIndex: number;
}): Promise<GraphRepairProposal | null> {
  const { repoRoot, node, source, sourceIndex } = input;
  const base = {
    node_id: node.id,
    node_name: node.name,
    source_index: sourceIndex,
    file_path: source.file_path,
    line_range: source.line_range as [number, number],
    stored_hash: source.content_hash,
    stored_range_hash: source.range_hash,
  };

  const safePath = safeRepoPath(repoRoot, source.file_path);
  if (!safePath.ok) {
    return {
      ...base,
      reason: "unsafe_path",
      action: "fix_unsafe_path",
      legacy: source.range_hash === undefined,
      explanation:
        "Source path is not a safe repo-relative file path; replace it before trusting this node.",
    };
  }

  let content: Buffer;
  try {
    content = await fs.readFile(safePath.absolutePath);
  } catch (err) {
    const missing =
      err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ...base,
      reason: missing ? "missing" : "read_error",
      action: missing ? "deprecate_or_reanchor" : "inspect_read_error",
      legacy: source.range_hash === undefined,
      explanation: missing
        ? "Source file is missing; deprecate the node or re-anchor it to the replacement file."
        : "Source file could not be read; inspect filesystem permissions or transient read failures.",
    };
  }

  const currentHash = hashBuffer(content);
  const currentRangeHash = hashSourceRange(content, source.line_range);
  const replacement_source: SourceRef = {
    file_path: source.file_path,
    line_range: source.line_range,
    content_hash: currentHash,
    range_hash: currentRangeHash,
  };

  if (source.range_hash !== undefined) {
    if (currentRangeHash !== source.range_hash) {
      return {
        ...base,
        current_hash: currentHash,
        current_range_hash: currentRangeHash,
        reason: "anchor_changed",
        action: "review_and_merge",
        legacy: false,
        replacement_source,
        explanation:
          "The cited source range changed; re-read the range and merge an updated node only if the durable finding still holds.",
      };
    }

    if (currentHash !== source.content_hash) {
      return {
        ...base,
        current_hash: currentHash,
        current_range_hash: currentRangeHash,
        reason: "range_unchanged",
        action: "refresh_range_anchor",
        legacy: false,
        replacement_source: {
          ...replacement_source,
          range_hash: source.range_hash,
        },
        explanation:
          "The file changed outside the cited range; after inspection, refresh the full-file hash while keeping the range hash.",
      };
    }

    return null;
  }

  if (currentHash === source.content_hash) return null;

  return {
    ...base,
    current_hash: currentHash,
    current_range_hash: currentRangeHash,
    reason: "changed",
    action: "reanchor_legacy_source",
    legacy: true,
    replacement_source,
    explanation:
      "This is a legacy full-file anchor with no range hash; re-read the cited range and merge a range-aware source anchor if the finding still holds.",
  };
}

function buildSuggestions(input: {
  proposals: GraphRepairProposal[];
  rangeRefreshes: number;
  anchorReviews: number;
  legacyAnchors: number;
  missingSources: number;
  unsafeSources: number;
  readErrors: number;
}): string[] {
  if (input.proposals.length === 0) {
    return ["Graph anchors do not need repair."];
  }

  const suggestions: string[] = [];
  if (input.rangeRefreshes > 0) {
    suggestions.push(
      "Refresh range-unchanged anchors by merging the replacement_source after confirming the cited finding still holds.",
    );
  }
  if (input.legacyAnchors > 0) {
    suggestions.push(
      "Legacy full-file anchors need re-reading before they can be upgraded to range-aware replacement_source anchors.",
    );
  }
  if (input.anchorReviews > 0) {
    suggestions.push(
      "Changed source ranges require source review before updating or deprecating graph memory.",
    );
  }
  if (input.missingSources > 0) {
    suggestions.push(
      "Missing source files should usually lead to deprecation unless a replacement repo file is known.",
    );
  }
  if (input.unsafeSources > 0) {
    suggestions.push(
      "Unsafe source paths must be replaced with repo-relative file anchors.",
    );
  }
  if (input.readErrors > 0) {
    suggestions.push(
      "Read errors should be inspected before treating the affected memory as stale.",
    );
  }

  return suggestions;
}
