# Task 007: Implement GraphStore class

**Status:** in-progress
**Phase:** M2 — Sprint 2.1
**Estimate:** 3–4 hours
**Depends on:** task-006
**Blocks:** task-008, task-010

## Goal

Implement the `GraphStore` class per `TECH_SPEC.md` §3.2 + §3.4: load, atomic save (lock-protected), getNode (alias-aware), upsertNode (with merge semantics), ensureEdge, ensureTopic, basic query.

## Context

This is the in-memory + persistence layer. The MCP tools (Sprint 2.2) are thin wrappers around `GraphStore` methods.

References:

- `TECH_SPEC.md` §3.2 — class contract.
- `TECH_SPEC.md` §3.4 — concurrency model (proper-lockfile usage).
- `V1_SPEC.md` §7.3 — emit_node merge semantics (which `upsertNode` implements).

## Deliverables

- `src/graph.ts` — `GraphStore` class with all methods listed below.
- Supporting types/helpers as needed (e.g. `QueryResult` interface).

## API to implement

```ts
class GraphStore {
  private constructor(repoRoot: string, data: GraphFile);

  static async load(repoRoot: string): Promise<GraphStore>;

  // Read APIs (no lock needed — atomic-rename guarantees readers see complete file)
  query(question: string, limit?: number): { nodes: Node[]; edges: Edge[] };
  getNode(id: string): Node | null;  // resolves through aliases

  // Write APIs (mutate in-memory; caller invokes save())
  upsertNode(
    node: Node,
    opts: { activeTopic?: string; mergeWith?: string; forceNew?: { reason: string } }
  ): { merged: boolean; createdId: string };
  ensureEdge(from: string, to: string, kind: EdgeKind, note?: string): void;
  ensureTopic(name: string, autoCreated?: boolean): void;

  // Persistence
  async save(): Promise<void>;  // atomic + lock-protected
}
```

## Steps

1. **Implement `load(repoRoot)`:**
  - Compute path `<repoRoot>/.codemap/graph.json`.
  - If file does not exist: create directory, write empty graph (version 1, empty topics/nodes/edges, current ISO timestamp), then return a fresh store.
  - If exists: read, parse via `GraphFileSchema`. On schema parse failure, throw with a clear message (CLI catches and exits 2; MCP catches and writes to stderr).
2. **Implement `save()`** per `TECH_SPEC.md` §3.4:
  ```ts
   import { lock } from "proper-lockfile";
   import { promises as fs } from "node:fs";

   async save(): Promise<void> {
     const release = await lock(this.path, {
       retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
       stale: 10_000,
     });
     try {
       const tmp = `${this.path}.tmp`;
       await fs.writeFile(tmp, this.serialize(), "utf8");
       await fs.rename(tmp, this.path);
     } finally {
       await release();
     }
   }
  ```
   `serialize()` should produce JSON with 2-space indent and **sorted keys** for diff readability. (zod doesn't sort; use a recursive sorter or a tiny utility.)
3. **Implement `getNode(id)`:**
  - Direct lookup in `nodes[id]`.
  - On miss, scan all nodes' `aliases` arrays; return the first match.
  - Returns `null` on no match.
4. **Implement `upsertNode(node, opts)`** per V1_SPEC §7.3 merge semantics:
  - If `opts.mergeWith` is set: merge into that existing node id (extend tags, merge aliases, refresh `last_verified_at` and `sources[].content_hash`, replace summary if incoming `confidence ≥ existing`). Return `{ merged: true, createdId: opts.mergeWith }`.
  - Else if `node.id` exists: same merge logic, target = `node.id`. Return `{ merged: true, createdId: node.id }`.
  - Else: create. Auto-add `opts.activeTopic` to tags (if set and not already present). Return `{ merged: false, createdId: node.id }`.
  - Note: **collision detection lives in the `emit_node` tool layer (task-013), not here.** GraphStore just trusts that the caller has resolved collision.
5. **Implement `ensureEdge(from, to, kind, note?)`:**
  - Compute key via `edgeKey(from, to, kind)`.
  - If key exists: update `note` if provided, otherwise no-op.
  - Else: create.
6. **Implement `ensureTopic(name, autoCreated = true)`:**
  - If `topics[name]` exists: no-op.
  - Else: add with current timestamp and `autoCreated`.
7. **Implement `query(question, limit = 10)`:**
  - Tokenize `question` into lowercase words (split on whitespace).
  - For each node in the graph, compute a relevance score:
    - +2 per word that matches a tag exactly.
    - +1 per word found in `name` (case-insensitive).
    - +1 per word found in `summary` (case-insensitive).
    - +1.5 per word matching an alias.
  - Sort by score descending. Return top `limit` nodes plus all edges where both endpoints are in the returned set.
  - Ignore deprecated nodes by default (status === "deprecated").
   This is intentionally crude. Better retrieval (embeddings) is v2.

## Exit criteria

- All methods listed compile and typecheck.
- `load()` creates `.codemap/graph.json` if absent.
- `save()` uses `proper-lockfile` and atomic rename per TECH_SPEC §3.4.
- `getNode()` resolves through aliases.
- `upsertNode()` merge logic matches V1_SPEC §7.3 (incl. `mergeWith` and the "incoming confidence ≥ existing" rule).
- `ensureEdge()` is idempotent on duplicate `(from,to,kind)` triples.
- `query()` returns reasonable matches on a small fixture graph (verified in task-010).
- No `any` types.

## Notes

- **Path configurability:** allow the path to be overridden in tests. Either pass an optional `customPath` to `load`, or read an env var like `CODEMAP_GRAPH_PATH`. Tests need this.
- **Crash-safety test belongs to task-010.** Don't write the test here; just make sure the implementation supports it.
- **Don't optimize `query()`.** O(N) over the node set is fine for v1 (assumed <1k nodes).
- **Sorted-key serialization:** important for clean git diffs. A small recursive utility:
  ```ts
  function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sortKeys(v)])
      );
    }
    return value;
  }
  ```
- **Don't add caching yet.** Premature.

