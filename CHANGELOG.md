# Changelog

All notable user-facing changes to Codemap are documented here.

## Unreleased

### Added

- `graph_repair` / `codemap repair-graph`, a read-only graph memory repair
  planner that turns stale, range-fresh, missing, unsafe, unreadable, and
  legacy source anchors into concrete replacement or review proposals.
- Source-index-derived repo map ranking for `query_context`,
  `changes_context`, and generated repo guidance. It scores files and symbols
  from local imports, references, query matches, and change seeds while keeping
  the result rebuildable and separate from curated graph memory.

## 0.7.0 - 2026-05-10

This release focuses on making Codemap faster and more accurate for everyday
repository work. It improves diff analysis, setup, retrieval, source indexing,
and TypeScript/JavaScript impact context while keeping graph memory local,
reviewable, and codebase-scoped.

### Added

- `changes_context`, a diff-aware MCP and CLI workflow that maps git changes to
  indexed symbols, stale graph anchors, likely affected tests/docs, and
  writeback suggestions.
- `codemap setup`, a global setup command for configuring supported MCP clients
  and checking install health.
- `codemap generate-skills`, a read-only repo guidance generator built from the
  local source index and curated graph highlights.
- Compact `query_context` modes for smaller planning responses without losing
  access to full graph/source context when needed.
- Persisted BM25 search data inside the rebuildable source index, plus an
  in-process search-ready cache for repeated queries.
- TypeScript/JavaScript AST extraction for symbols, imports, exports, and exact
  identifier reference coordinates.

### Improved

- Source search now uses match explanations, result diversity, dependency
  context, impact context, and stale-index warnings to make hits easier to
  trust and inspect.
- Impact analysis prefers exact identifier references where available, with
  chunk-based fallback for unsupported or truncated files.
- Graph memory ranking now accounts for confidence, freshness, source-anchor
  state, node kind, and deprecated status.
- Generated project guidance is versioned and checkable so agents can verify
  whether lifecycle instructions are current.
- README and package metadata now present Codemap as a polished public package,
  with release notes linked directly from npm.

### Compatibility

- Existing `.codemap/graph.json` files remain compatible.
- Existing source indexes remain loadable; new search and reference data is
  rebuildable with `codemap scan` or `index_codebase`.
- All new writeback and guidance helpers are read-only unless explicitly using
  `emit_node`, `link`, or a documented write command.

## 0.6.0 - 2026-05-06

Codemap 0.6.0 shipped the behavior-consistency sequence that introduced
retrieval explanations, source-result diversity, TS/JS symbol and impact
context, memory quality ranking, and read-only workflow writeback suggestions.
