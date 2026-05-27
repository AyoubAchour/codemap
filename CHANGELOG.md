# Changelog

All notable user-facing changes to Codemap are documented here.

## Unreleased

### Added

- Rebuildable capture summaries via `codemap capture-summary`, writing
  `.codemap/index/capture/sessions.json` and
  `.codemap/index/capture/profile.json` from captured session evidence without
  touching graph memory.
- Optional capture-summary evidence in `recall_context` and
  `codemap recall-context --include-capture-summary`, with explicit provenance
  and byte-budget accounting.
- Read-only capture audit reports via `codemap capture-report`, including
  session timelines, recall hits, writeback suggestions, graph writes, ignored
  capture lines, stale anchors, and captured budget fields.
- Benchmark-only local semantic retrieval via
  `codemap benchmark-retrieval --semantic-provider local-hash`, plus
  lexical/graph/mixed/local-vector variant metrics. The provider is
  dependency-free and remains outside runtime recall.

## 0.8.0 - 2026-05-11

This release makes Codemap more agentic in everyday repository work. It adds
repair planning for stale graph anchors, a source-derived repo map for better
context selection, source-index watch mode, benchmark-only semantic retrieval
adapters, richer graph-memory quality signals, and a larger retrieval
benchmark suite.

### Added

- `graph_repair` / `codemap repair-graph`, a read-only graph memory repair
  planner that turns stale, range-fresh, missing, unsafe, unreadable, and
  legacy source anchors into concrete replacement or review proposals.
- Source-index-derived repo map ranking for `query_context`,
  `changes_context`, and generated repo guidance. It scores files and symbols
  from local imports, references, query matches, and change seeds while keeping
  the result rebuildable and separate from curated graph memory.
- `codemap watch`, `codemap watch --once`, `codemap watch --status`, and the
  `watch_status` MCP tool for keeping the rebuildable source index fresh
  without writing graph memory.
- Optional benchmark-only semantic retrieval and reranking adapter contracts.
  Providers remain disabled by default; experiments can be measured without
  adding hosted dependencies to the runtime.
- Richer graph memory quality metadata for utility, maturity, usage recency,
  source confirmation, and supersession, surfaced in query results and
  writeback suggestion ordering.
- A larger retrieval benchmark suite covering semantic wording, typos,
  cross-file impact, renamed symbols, stale graph cases, docs/tests discovery,
  and a non-Codemap fixture repo.

### Improved

- Graph memory trust explanations now include explicit quality signals and
  clearer scoring defaults for unrated utility.
- Writeback suggestions rank related graph memories by quality and scope stale
  related-memory evidence to the same ranked set.
- `filterStalenessReportForNodes` preserves the original source-check count so
  filtered reports do not misrepresent the check scope.

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
