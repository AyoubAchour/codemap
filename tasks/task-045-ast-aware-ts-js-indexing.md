# Task 045 — AST-aware TS/JS indexing

Status: todo

Phase: Phase 4 / accuracy

## Intent

Improve symbol, import, and reference extraction by replacing fragile regex
heuristics with an AST-backed TypeScript and JavaScript path.

## Context

Tools like Tree-sitter, GitHub code navigation, and SCIP-style indexers show the
value of source ranges, definitions, and references as first-class index data.
Codemap should start narrow with TS/JS and keep the current lexical fallback for
unsupported cases.

## Deliverables

- Choose the AST backend for TS/JS after a small local spike.
- Extract definitions, imports, exports, and approximate references with real
  source ranges.
- Preserve the current source-index schema or add a compatible version bump.
- Keep regex extraction as a fallback where AST parsing fails.

## Exit Criteria

- [ ] TS/JS symbols and imports are at least as complete as the current index.
- [ ] References have file/line coordinates that match navigable source.
- [ ] Tests cover common TS syntax, default exports, re-exports, and parse
      failures.

