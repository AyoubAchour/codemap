import { promises as fs } from "node:fs";
import * as path from "node:path";
import { lock } from "proper-lockfile";

import { edgeKey, GraphFileSchema, parseEdgeKey } from "./schema.js";
import type { Edge, EdgeKind, GraphFile, Node, StoredNode } from "./types.js";
import { ensureSeedFile } from "./util/lock.js";
import { applyRepairs, type ValidationResult, validate } from "./validator.js";

// =============================================================
// GraphStore — persistence + read/write APIs over .codemap/graph.json
//
// Source of truth for behavior:
//   V1_SPEC §6 (data model), §7.3 (merge semantics), §9 (rules), §10 (storage)
//   TECH_SPEC §3.2 (class contract), §3.3 (validator), §3.4 (concurrency model)
// =============================================================

const GRAPH_DIR = ".codemap";
const GRAPH_FILE = "graph.json";
const SCHEMA_VERSION = 1 as const;

export interface QueryResult {
  nodes: Node[];
  edges: Edge[];
}

export interface UpsertOptions {
  /** Active topic auto-tagged onto the node. Per V1_SPEC §7.5. */
  activeTopic?: string;
  /** Force a merge into a specific existing id, ignoring `node.id`. */
  mergeWith?: string;
  /** Reserved for future server-side collision handling (task-013). Not used by GraphStore. */
  forceNew?: { reason: string };
}

export interface UpsertResult {
  /** True if an existing node was merged into; false if a new node was created. */
  merged: boolean;
  /** The id of the resulting node. */
  createdId: string;
}

export class GraphStore {
  private readonly path: string;
  private data: GraphFile;
  private lastValidation: ValidationResult | null;

  private constructor(
    graphPath: string,
    data: GraphFile,
    lastValidation: ValidationResult | null = null,
  ) {
    this.path = graphPath;
    this.data = data;
    this.lastValidation = lastValidation;
  }

  /**
   * Load the graph from disk. Creates an empty in-memory graph if no file exists yet
   * (the file is materialized on the first `save()`).
   *
   * Path resolution order: `options.customPath` → `CODEMAP_GRAPH_PATH` env var →
   * `<repoRoot>/.codemap/graph.json`.
   */
  static async load(
    repoRoot: string,
    options?: { customPath?: string },
  ): Promise<GraphStore> {
    const graphPath =
      options?.customPath ??
      process.env.CODEMAP_GRAPH_PATH ??
      path.join(repoRoot, GRAPH_DIR, GRAPH_FILE);

    let data: GraphFile;
    try {
      const raw = await fs.readFile(graphPath, "utf8");
      const parsed = JSON.parse(raw);
      data = GraphFileSchema.parse(parsed);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // No graph file yet — start with an empty graph in memory.
        // It will be persisted on the first save().
        data = {
          version: SCHEMA_VERSION,
          created_at: new Date().toISOString(),
          topics: {},
          nodes: {},
          edges: {},
        };
      } else {
        // Schema-parse failure or unexpected I/O error. Propagate so callers
        // (CLI / MCP server entry) can surface a structured error.
        throw err;
      }
    }

    // Run post-schema validator and apply auto-repairs in-memory.
    // Repairs persist on the next save(). Per V1_SPEC §9.8.
    const lastValidation = validate(data);
    if (lastValidation.repairs.length > 0) {
      data = applyRepairs(data, lastValidation);
    }

    return new GraphStore(graphPath, data, lastValidation);
  }

  /**
   * The validation result from the most recent load(), or null if validate()
   * has not been run. Useful for telemetry (count of repairs / warnings) and
   * for the future `codemap validate` CLI (task-018).
   */
  validationResult(): Readonly<ValidationResult> | null {
    return this.lastValidation;
  }

  // ===========================================================
  // Read APIs (no lock needed — atomic-rename guarantees readers
  // always see a complete file)
  // ===========================================================

  /**
   * Look up a node by its canonical id, or by any of its aliases.
   * Returns `null` on no match. Resolves through aliases per V1_SPEC §6.1.
   */
  getNode(id: string): Node | null {
    const direct = this.data.nodes[id];
    if (direct) {
      return { id, ...direct };
    }
    for (const [otherId, node] of Object.entries(this.data.nodes)) {
      if (node.aliases.includes(id)) {
        return { id: otherId, ...node };
      }
    }
    return null;
  }

  /**
   * Score nodes against a free-text question by tag overlap + name/summary/alias text match.
   * Returns top `limit` nodes plus all edges whose endpoints are both in the result set.
   * Deprecated nodes are excluded by default.
   *
   * Scoring (per task-007 spec): +2 per token matching a tag, +1 per token in name,
   * +1 per token in summary, +1.5 per token matching an alias.
   */
  query(question: string, limit = 10): QueryResult {
    const tokens = question.toLowerCase().split(/\s+/).filter(Boolean);
    const scored: Array<{ id: string; node: StoredNode; score: number }> = [];

    for (const [id, node] of Object.entries(this.data.nodes)) {
      if (node.status === "deprecated") continue;

      const nameLower = node.name.toLowerCase();
      const summaryLower = node.summary.toLowerCase();
      const tagsLower = node.tags.map((t) => t.toLowerCase());
      const aliasesLower = node.aliases.map((a) => a.toLowerCase());

      let score = 0;
      for (const token of tokens) {
        // Substring match across all fields for symmetry with name/summary.
        // Higher-signal channels (tag, alias) keep their higher weight.
        if (tagsLower.some((t) => t.includes(token))) score += 2;
        if (nameLower.includes(token)) score += 1;
        if (summaryLower.includes(token)) score += 1;
        if (aliasesLower.some((a) => a.includes(token))) score += 1.5;
      }

      if (score > 0) {
        scored.push({ id, node, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    const topIds = new Set(top.map((s) => s.id));

    const nodes: Node[] = top.map((s) => ({ id: s.id, ...s.node }));
    const edges: Edge[] = [];
    for (const [key, value] of Object.entries(this.data.edges)) {
      const parsed = parseEdgeKey(key);
      if (!parsed) continue;
      const { from, to, kind } = parsed;
      if (topIds.has(from) && topIds.has(to)) {
        const edge: Edge = { from, to, kind };
        if (value.note !== undefined) {
          edge.note = value.note;
        }
        edges.push(edge);
      }
    }

    return { nodes, edges };
  }

  // ===========================================================
  // Write APIs (mutate in-memory; caller invokes save())
  // ===========================================================

  /**
   * Create a new node, or merge into an existing one with the same id (or `opts.mergeWith`).
   * Merge semantics per V1_SPEC §7.3:
   *  - Extend tags (and add active topic).
   *  - Merge aliases.
   *  - Refresh sources[].content_hash and last_verified_at (incoming wins).
   *  - Replace summary only if incoming confidence ≥ existing confidence.
   *  - Kind and name on existing wins (canonical, set on first emit).
   *  - Status: incoming wins (allows deprecation toggle).
   *
   * Note: server-side collision detection (task-013) lives at the tool layer.
   * GraphStore trusts the caller has already resolved any collision.
   */
  upsertNode(node: Node, opts: UpsertOptions = {}): UpsertResult {
    const targetId = opts.mergeWith ?? node.id;
    const existing = this.data.nodes[targetId];
    const { id: _id, ...incoming } = node;

    if (existing) {
      const mergedTags = Array.from(
        new Set([...existing.tags, ...incoming.tags]),
      );
      if (opts.activeTopic && !mergedTags.includes(opts.activeTopic)) {
        mergedTags.push(opts.activeTopic);
      }
      const mergedAliases = Array.from(
        new Set([...existing.aliases, ...incoming.aliases]),
      );

      const summaryReplaces = incoming.confidence >= existing.confidence;

      const merged: StoredNode = {
        kind: existing.kind, // canonical, don't flap
        name: existing.name, // canonical, don't flap
        summary: summaryReplaces ? incoming.summary : existing.summary,
        confidence: summaryReplaces ? incoming.confidence : existing.confidence,
        sources: incoming.sources, // refresh on merge
        tags: mergedTags,
        aliases: mergedAliases,
        status: incoming.status,
        last_verified_at: incoming.last_verified_at,
      };
      this.data.nodes[targetId] = merged;
      return { merged: true, createdId: targetId };
    }

    const tags = [...incoming.tags];
    if (opts.activeTopic && !tags.includes(opts.activeTopic)) {
      tags.push(opts.activeTopic);
    }
    // Use targetId — when opts.mergeWith was set but the target didn't exist,
    // the caller's intent ("write to this canonical id") wins over node.id.
    // Without this, a `mergeWith` to a missing id would silently create at
    // node.id, abandoning the caller's contract.
    this.data.nodes[targetId] = { ...incoming, tags };
    return { merged: false, createdId: targetId };
  }

  /**
   * Idempotent. Identity is the triple (from, to, kind). Calling again with the
   * same triple updates `note`; calling without `note` is a no-op when the edge exists.
   */
  ensureEdge(from: string, to: string, kind: EdgeKind, note?: string): void {
    const key = edgeKey(from, to, kind);
    const existing = this.data.edges[key];
    if (existing) {
      if (note !== undefined) {
        this.data.edges[key] = { note };
      }
      return;
    }
    this.data.edges[key] = note !== undefined ? { note } : {};
  }

  /**
   * Idempotent. Adds the topic if missing; no-op if it already exists.
   */
  ensureTopic(name: string, autoCreated = true): void {
    if (this.data.topics[name]) return;
    this.data.topics[name] = {
      created_at: new Date().toISOString(),
      auto_created: autoCreated,
    };
  }

  /**
   * Manual override of node fields. Bypasses the upsertNode merge logic
   * (which gates `summary` replacement on `confidence ≥ existing`) — for
   * CLI corrections per task-015, where the user has explicitly stated
   * "set this field to this value." Returns false if no node has this id.
   *
   * `last_verified_at` defaults to now (the manual edit IS verification).
   */
  overrideNode(id: string, patch: Partial<StoredNode>): boolean {
    const existing = this.data.nodes[id];
    if (!existing) return false;
    this.data.nodes[id] = {
      ...existing,
      ...patch,
      last_verified_at: patch.last_verified_at ?? new Date().toISOString(),
    };
    return true;
  }

  // ===========================================================
  // Persistence — atomic + lock-protected (TECH_SPEC §3.4)
  // ===========================================================

  async save(): Promise<void> {
    await ensureSeedFile(this.path, {
      version: SCHEMA_VERSION,
      created_at: this.data.created_at,
      topics: {},
      nodes: {},
      edges: {},
    });

    const release = await lock(this.path, {
      retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
      stale: 10_000,
    });
    try {
      const tmp = `${this.path}.tmp`;
      await fs.writeFile(tmp, this.serialize(), "utf8");
      // Test-only debug pause between writeFile and rename. Used by the
      // atomic-save crash-injection test to land a SIGKILL during this window.
      // Belt-and-suspenders: gated on BOTH env vars to make accidental
      // production activation impossible.
      if (
        process.env.NODE_ENV === "test" &&
        process.env.CODEMAP_DEBUG_SLOW_SAVE === "1"
      ) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      await fs.rename(tmp, this.path);
    } finally {
      await release();
    }
  }

  // Test-only / advanced: read-only access to the in-memory state.
  // Avoid using outside of tests — the public API should suffice.
  /** @internal */
  _data(): Readonly<GraphFile> {
    return this.data;
  }

  // ===========================================================
  // Internal
  // ===========================================================

  private serialize(): string {
    return `${JSON.stringify(sortKeysDeep(this.data), null, 2)}\n`;
  }
}

/**
 * Recursively sort object keys for stable, diff-friendly serialization.
 * Arrays preserve their order.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}
