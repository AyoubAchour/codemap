import { parseEdgeKey } from "./schema.js";
import type { GraphFile } from "./types.js";

// =============================================================
// Validator — load-time integrity checks per V1_SPEC §9.8 + TECH_SPEC §3.3
//
// Schema validation is the FIRST gate (handled at parse time by
// GraphFileSchema). The validator runs the post-schema checks:
//   1. Dangling edges (endpoints don't exist) — auto-repaired (drop edge).
//   2. Duplicate aliases (same alias on >1 node) — warning only; user resolves.
//   3. Topic coverage (tag without a topics{} entry) — auto-repaired (add topic).
//
// Order matters per task-008: dangling-edges → alias-uniqueness → topic-coverage.
// =============================================================

export type ValidationIssue =
  | { kind: "schema_error"; message: string }
  | { kind: "dangling_edge"; edgeKey: string; missingEndpoint: string }
  | { kind: "duplicate_alias"; alias: string; nodeIds: string[] }
  | { kind: "missing_topic"; topic: string; nodeId: string };

export interface ValidationResult {
  /** False only on schema_error. */
  ok: boolean;
  /** Hard failures (currently only `schema_error` populates this). */
  errors: ValidationIssue[];
  /** Soft issues that need human attention but don't block load (e.g. duplicate aliases). */
  warnings: ValidationIssue[];
  /** Issues that were auto-fixed by `applyRepairs`. */
  repairs: ValidationIssue[];
}

/**
 * Runs all post-schema integrity checks on a parsed GraphFile.
 * Schema validation must already have succeeded — callers using
 * GraphFileSchema.parse() get that for free; raw inputs should go
 * through the schema first or use `validateRaw` (future).
 */
export function validate(graph: GraphFile): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const repairs: ValidationIssue[] = [];

  // 1. Dangling edges. Parse from the right (defense-in-depth: matches
  //    GraphStore.query()'s parsing strategy). Schema constraints in
  //    EdgeKeySchema make this redundant for well-formed graphs, but
  //    a manual edit could in principle bypass them.
  for (const key of Object.keys(graph.edges)) {
    const parsed = parseEdgeKey(key);
    if (!parsed) continue;
    const { from, to } = parsed;
    if (!graph.nodes[from]) {
      repairs.push({
        kind: "dangling_edge",
        edgeKey: key,
        missingEndpoint: from,
      });
    }
    if (!graph.nodes[to]) {
      repairs.push({
        kind: "dangling_edge",
        edgeKey: key,
        missingEndpoint: to,
      });
    }
  }

  // 2. Alias uniqueness. Same alias on >1 node id is a *warning* — let the
  //    user resolve via `codemap correct` (task-018). Aliases on deprecated
  //    nodes are still valid (don't filter by status).
  const aliasOwners = new Map<string, string[]>();
  for (const [id, node] of Object.entries(graph.nodes)) {
    for (const alias of node.aliases) {
      const owners = aliasOwners.get(alias);
      if (owners) {
        owners.push(id);
      } else {
        aliasOwners.set(alias, [id]);
      }
    }
  }
  for (const [alias, ids] of aliasOwners) {
    if (ids.length > 1) {
      warnings.push({ kind: "duplicate_alias", alias, nodeIds: [...ids] });
    }
  }

  // 3. Topic coverage. Every tag on every node should resolve to an entry
  //    in `topics{}` — auto-fill if missing.
  for (const [id, node] of Object.entries(graph.nodes)) {
    for (const tag of node.tags) {
      if (!graph.topics[tag]) {
        repairs.push({ kind: "missing_topic", topic: tag, nodeId: id });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    repairs,
  };
}

/**
 * Apply auto-repairable issues to a graph and return the repaired graph.
 * Pure: does not mutate the input.
 *
 * - `dangling_edge`: deletes the edge entry.
 * - `missing_topic`: adds the topic entry (idempotent across duplicates;
 *   only the first occurrence creates).
 * - `duplicate_alias`: not auto-repaired (warning only).
 * - `schema_error`: not auto-repaired (caller's responsibility).
 */
export function applyRepairs(
  graph: GraphFile,
  result: ValidationResult,
): GraphFile {
  if (result.repairs.length === 0) return graph;

  const edges = { ...graph.edges };
  const topics = { ...graph.topics };
  const now = new Date().toISOString();

  for (const issue of result.repairs) {
    if (issue.kind === "dangling_edge") {
      delete edges[issue.edgeKey];
    } else if (issue.kind === "missing_topic") {
      if (!topics[issue.topic]) {
        topics[issue.topic] = {
          created_at: now,
          auto_created: true,
        };
      }
    }
  }

  return {
    ...graph,
    edges,
    topics,
  };
}
