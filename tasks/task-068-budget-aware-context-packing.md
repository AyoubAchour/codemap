# Task 068: Budget-Aware Context Packing

**Status:** done
**Phase:** Phase 4 / retrieval
**Estimate:** 1 day
**Depends on:** task-067
**Blocks:** future query-context packing and runtime recall tuning

## Goal

Make compact recall spend its byte budget across evidence lanes predictably
instead of letting optional capture-summary evidence crowd out source evidence.

## Context

Task 067 reduced irrelevant source hits, but `recall_context` still ranked graph,
source, and optional capture-summary candidates as one flat list. That can make
mixed recall less useful under small budgets: an optional rebuildable capture
summary may appear before source evidence, and downstream users cannot see how
the budget was spent by lane.

The optimization principle remains local and deterministic. This task does not
add semantic runtime retrieval, LLM packing, hosted services, or automatic graph
writes.

## Deliverables

- Balanced mixed-mode candidate ordering that interleaves graph, source, then
  capture-summary evidence by rank.
- Per-lane `budget.packing` metadata in `recall_context` responses.
- Final response budget enforcement that accounts for omitted-result warnings
  and packing metadata, not only selected candidate payloads.
- Focused recall-context regression tests.

## Steps

1. Add failing recall-context tests for mixed evidence ordering and lane packing
   metadata.
2. Update mixed candidate selection to preserve graph/source coverage before
   optional capture-summary evidence.
3. Add compact packing statistics for participating lanes.
4. Re-check final response size after budget warnings and packing metadata are
   applied.
5. Update docs and changelog.

## Exit Criteria

- [x] Mixed recall with graph, source, and capture summaries returns graph,
      source, then capture evidence under a small limit.
- [x] `recall_context` reports selected, omitted, omitted-by-budget, candidate,
      and used-byte counts by evidence lane.
- [x] Tight budget responses remain within their configured byte budget after
      packing metadata is included.
- [x] Capture summaries remain optional rebuildable evidence.
- [x] Focused tests cover the behavior.

## Implementation Notes

Mixed mode now interleaves ranked lanes as graph, source, capture-summary,
repeating by lane depth. This preserves the existing within-lane ranking while
making optional capture summaries additive instead of allowing them to crowd out
source evidence.

`budget.packing` uses strategy `balanced_relevance_density_v1` and reports stats
only for lanes that participated in candidate selection or budget decisions. That
keeps tight-budget responses compact while still making budget allocation
auditable.

The final response is re-fit after budget warnings and packing metadata are
known. If fixed metadata would push the response over budget, the last selected
result is omitted and counted under that lane's `omitted_by_budget`.

## Notes

This task intentionally scopes packing to `recall_context`. `query_context`
still returns a larger planning packet and should get its own packing task if
dogfood shows repo-map or impact-context evidence crowding out higher-value
graph/source evidence.
