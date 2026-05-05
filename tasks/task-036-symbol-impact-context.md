# Task 036: TS/JS Symbol And Impact Context

**Status:** todo
**Phase:** Phase 4 / behavior consistency
**Estimate:** 3-5 days
**Depends on:** task-035
**Blocks:** task-037, task-038

## Goal

Add narrow TS/JS symbol and impact context so agents can answer "what changes if
I touch this?" before editing.

## Context

GitNexus, Serena, codebase-memory, and Symbols MCP all make agents stronger by
exposing symbol-level navigation: definitions, references, imports, importers,
and impact paths. Codemap currently has file-level chunks, extracted symbols,
imports, exports, and bounded dependency context. That is useful, but it is not
yet a real impact view.

Start narrow. TS/JS is the existing supported lane, and the goal is agent
planning context, not a full IDE or static analyzer.

## Deliverables

- A TS/JS symbol context model built from the existing source index.
- Direct impact context for a file or symbol:
  - definition chunk
  - exported symbols
  - direct imports
  - direct importers
  - likely affected symbols/files
- `query_context` can include bounded impact context when a query clearly
  targets a symbol or file.
- CLI and/or MCP access for targeted impact inspection.
- Tests on small TS fixtures with imports, re-exports, and call sites.

## Proposed Shape

1. Extend the source index with a symbol lookup map derived from existing
   symbol/import/export data.
2. Add a small resolver for TS/JS module paths that reuses the existing
   dependency-context resolver.
3. Add an impact builder that starts with direct relationships only:
   - imports
   - imported_by
   - exported symbol owner
   - textual references inside indexed chunks, clearly marked as approximate
4. Expose the result through one of:
   - `query_context` when relevant
   - `search_source` with `include_impact`
   - a new focused tool/CLI command if the shape is too large
5. Keep all output bounded and explain approximation levels.

## Exit Criteria

- [ ] For a TS symbol query, Codemap can identify its defining file/chunk.
- [ ] For a file query, Codemap returns direct imports and importers.
- [ ] Impact context distinguishes exact import/export relationships from
      approximate text references.
- [ ] Output is bounded so large repos do not flood agent context.
- [ ] Tests cover direct import impact, reverse importer impact, and ambiguous
      symbol names.
- [ ] Docs describe this as planning context, not proof of all runtime effects.

## Notes

Do not chase full call-graph precision in this task. The first win is direct,
trustworthy context that prevents obvious wrong edits.
