# Task 028: Local source index for code discovery

**Status:** done
**Phase:** Phase 4 / behavior consistency
**Started:** 2026-05-03
**Depends on:** task-027

## Goal

Add the first DeepContext-style advantage to Codemap without polluting the curated graph: a rebuildable local source index for fast source discovery.

## Context

The graph remains the durable memory layer for decisions, invariants, gotchas, and relationships. Source retrieval is a separate local cache used before file inspection, not a source of automatic graph nodes.

## Deliverables

- Rebuildable `.codemap/index/source.json` cache.
- Local lexical/symbol ranking over TypeScript and JavaScript chunks.
- CLI commands: `scan`, `search-source`, `index-status`, `clear-index`.
- MCP tools: `index_codebase`, `search_source`, `get_index_status`, `clear_index`.
- Tests covering scan/search/status/cache separation from graph memory.

## Exit criteria

- [x] Source index is stored separately from `.codemap/graph.json`.
- [x] Indexing skips vendor/build/generated paths.
- [x] Search returns file paths, line ranges, chunk content, symbols, imports, exports, and related graph nodes when source anchors match.
- [x] Clearing the index does not modify graph memory.
- [x] `bun run typecheck`
- [x] `bun test`
- [x] CLI smoke: scan, search-source, index-status, clear-index.

## Notes

Embeddings, hosted/vector providers, background workers, and multi-language AST parsing are intentionally deferred. The first slice prioritizes local-first usefulness and graph hygiene.
