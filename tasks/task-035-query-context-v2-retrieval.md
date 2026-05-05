# Task 035: query_context V2 Retrieval

**Status:** todo
**Phase:** Phase 4 / behavior consistency
**Estimate:** 2-4 days
**Depends on:** task-034
**Blocks:** task-036, task-037

## Goal

Improve `query_context` so agents receive better local context with fewer tool
calls and clearer reasons for each result.

## Context

DeepContext's strongest advantage is retrieval: symbol-aware semantic chunks,
hybrid search, reranking, incremental indexing, and precise context instead of
large grep dumps. Codemap should borrow the useful local-first pieces without
turning curated graph memory into an auto-generated index.

Codemap already has lexical/BM25-style source search, graph memory, source
staleness, related nodes, and dependency context. The next slice should improve
result quality and explainability before considering optional embeddings.

## Deliverables

- `query_context` response includes match reasons for graph nodes and source
  hits.
- Source search ranking uses symbol/path/import/export signals more explicitly.
- Result diversity prevents one file or one symbol cluster from dominating the
  response.
- Query-time warnings explain whether results came from curated memory,
  rebuildable source index, or stale graph anchors.
- Optional embedding/provider design is documented but disabled by default.

## Proposed Shape

1. Add `why_matched` / `match_reasons` to source results:
   - symbol name match
   - path segment match
   - import/export match
   - content term match
   - related graph node anchor
2. Add a small score breakdown for source results, keeping the public shape
   compact and bounded.
3. Add diversity controls:
   - cap repeated chunks from the same file
   - prefer distinct symbols/files before filling remaining slots
   - preserve deterministic ordering for tests
4. Tune ranking using fixtures where exact symbol/path queries should beat
   broad content-only hits.
5. Document embeddings as a future pluggable layer only after local lexical and
   symbol retrieval shows real misses.

## Exit Criteria

- [ ] `query_context` results include bounded, useful match reasons.
- [ ] Source result ordering improves on fixture queries for symbol names,
      path names, imports, and broad natural-language questions.
- [ ] Diversity prevents repeated chunks from crowding out adjacent files.
- [ ] Existing MCP/CLI callers remain backward compatible.
- [ ] Tests cover score reasons, diversity, and deterministic ordering.
- [ ] Docs explain that source hits are discovery hints, not graph memory.

## Notes

Keep this local-first. Hosted embeddings or rerankers should remain optional
design notes until we have dogfood evidence that local retrieval is missing
important context.
