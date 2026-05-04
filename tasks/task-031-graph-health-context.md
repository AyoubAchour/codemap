# Task 031: Graph health and dependency context

**Status:** done
**Phase:** Phase 4 / behavior consistency
**Target version:** 0.5.0
**Depends on:** task-028, task-030

## Goal

Make Codemap more trustworthy in real agent sessions by exposing graph health
problems directly and returning nearby source dependencies during context
retrieval.

## Context

After `query_context` shipped, dogfood on this repo showed that agents can see
stale source anchors but do not have a single read-only tool for graph health.
The same dogfood pass showed source hits are more useful when they include
nearby imports/importers, because agents otherwise inspect isolated chunks and
miss adjacent behavior.

## Deliverables

- Shared `inspectGraphHealth()` core.
- MCP tool `graph_health`.
- CLI command `codemap doctor` with bounded issue detail.
- Dependency context on source-search results, exposed through `search_source`
  and `query_context`.
- Generated agent guidance updated so MCP clients learn the correct use of
  `graph_health` and dependency context.
- Docs truth pass for current status, task index drift, and handoff notes.

## Exit criteria

- [x] `graph_health` is listed by MCP `tools/list` and returns structured
  content.
- [x] `codemap doctor` exits 0 on clean graphs, 1 on health issues, and 2 on
  load/schema failures.
- [x] Health responses keep full totals but cap stale-anchor detail by default
  so large stale graphs remain readable.
- [x] Source search can return bounded `imports` and `imported_by` dependency
  context without treating it as graph memory.
- [x] `query_context` includes dependency context by default.
- [x] README, spec, roadmap, handoff, task index, and generated guidance
  describe the new behavior.
- [x] Targeted unit/integration tests pass.

## Dogfood evidence

- `codemap validate` was clean after local duplicate-alias hygiene.
- `codemap rollup` produced a weekly aggregate for this repo's current local
  graph/metrics.
- `query_context` surfaced stale visual-extension anchors, confirming the need
  for a dedicated health view.

## Notes

`graph_health` is intentionally read-only. It does not repair, deprecate, or
re-anchor nodes automatically; agents still need to inspect real files and use
`emit_node`, `link`, or human CLI correction for durable changes.
