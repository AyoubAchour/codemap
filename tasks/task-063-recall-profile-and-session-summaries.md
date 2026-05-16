# Task 063: Recall Profiles and Session Summaries

**Status:** todo
**Phase:** Phase 4 / recall
**Estimate:** 4-6 days
**Depends on:** task-060, task-062
**Blocks:** task-064

## Goal

Create local summaries that make long-running project work easier to recall
without polluting curated graph memory.

## Context

Agentmemory compresses observations and session history into searchable memory.
Codemap can use a lighter version: rebuildable summaries and recall profiles
that remain evidence until a specific finding is promoted into graph memory.

## Deliverables

- Session summary generation from capture events.
- Project recall profile that lists active areas, recent decisions, recurring
  files, and unresolved writeback opportunities.
- Refresh behavior that updates summaries when capture evidence changes.
- Redaction/exclude behavior for sensitive captured text.

## Steps

1. Define summary/profile files under `.codemap/index/capture/`.
2. Generate summaries from event metadata first; add text summarization only if
   local deterministic heuristics are insufficient.
3. Feed summaries into `recall_context` as optional evidence.
4. Add tests for refresh, deletion, stale anchors, and redaction.
5. Document that summaries are rebuildable evidence, not graph memory.

## Exit Criteria

- [ ] Summaries improve recall without writing graph nodes.
- [ ] Deleting summaries does not affect `.codemap/graph.json`.
- [ ] Sensitive paths/text can be excluded.
- [ ] Stale source anchors are visible in recall output.

## Notes

Avoid adding an LLM dependency in this task unless the deterministic version
fails in dogfood.
