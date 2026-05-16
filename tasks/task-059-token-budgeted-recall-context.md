# Task 059: Token-Budgeted Recall Context

**Status:** todo
**Phase:** Phase 4 / retrieval
**Estimate:** 3-5 days
**Depends on:** task-058
**Blocks:** task-062, task-063, task-064

## Goal

Add a compact recall surface for small, budgeted context packets.

## Context

`query_context` is a planning tool: it fuses graph memory, source search,
status, impact hints, warnings, and expansion guidance. Agentmemory is better
for quick memory recall because it returns a small top-K packet under a stable
token budget.

## Deliverables

- MCP tool such as `recall_context`.
- CLI command such as `codemap recall-context`.
- Inputs for question, optional files/symbols, result limit, and token/byte
  budget.
- Output with budget accounting, graph/source provenance, trust/freshness
  warnings, omitted-result counts, and source anchors.

## Steps

1. Implement shared recall logic in a new `src/recall_context.ts`.
2. Register MCP and CLI wrappers.
3. Reuse existing graph quality and source-index ranking where possible.
4. Add tests for budget compliance and provenance warnings.
5. Add docs after the surface is stable.

## Exit Criteria

- [ ] Recall output respects the configured budget in tests.
- [ ] Output never hides whether a result came from curated graph memory or
      rebuildable source/capture evidence.
- [ ] Empty and stale-result cases are explicit.
- [ ] CLI and MCP paths share the same core implementation.

## Notes

This is not a replacement for `query_context`. It is the small recall primitive
that agents can use often without dragging a large planning payload into every
turn.
