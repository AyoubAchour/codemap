# Task 037: Memory Quality And Ranking

**Status:** todo
**Phase:** Phase 4 / behavior consistency
**Estimate:** 2-4 days
**Depends on:** task-035
**Blocks:** task-038

## Goal

Make agents trust the right graph memories first by surfacing quality, freshness,
confidence, and usage signals in ranking.

## Context

Memento/Engram-style memory systems emphasize typed memory, utility, recency,
decay, and policy. Codemap already stores confidence and verification time, and
it can detect stale source anchors. However, query results still mostly behave
like text matches, so an old stale node can compete with a fresh high-confidence
node unless the agent notices warnings.

This task should improve trust without bloating the graph schema or pretending
old knowledge is wrong just because it is old.

## Deliverables

- Query responses include a compact quality summary for each graph node.
- Ranking accounts for:
  - graph match score
  - confidence
  - source staleness
  - deprecated status
  - age since verification
  - optional usage/utility signals if already available locally
- `query_context` clearly separates high-trust memory from stale or low-trust
  memory.
- Tests prove stale or lower-confidence nodes are demoted but still visible when
  relevant.

## Proposed Shape

1. Add an internal quality scorer that works at query time.
2. Keep the persisted node schema stable unless a schema change is clearly
   justified.
3. Compute quality from existing fields first:
   - `confidence`
   - `last_verified_at`
   - staleness report
   - node kind
   - status
4. Optionally record lightweight usage in metrics, not graph nodes:
   - returned in query
   - selected/read via `get_node`
   - linked or merged later
5. Return quality details as bounded metadata, not long prose.

## Exit Criteria

- [ ] `query_graph` / `query_context` can expose quality metadata.
- [ ] Stale source anchors reduce trust ranking without hiding the node.
- [ ] Fresh high-confidence decision/invariant/gotcha nodes rank strongly.
- [ ] Deprecated nodes remain excluded by default.
- [ ] Tests cover freshness, confidence, staleness, and kind weighting.
- [ ] Docs explain how to interpret quality and stale warnings.

## Notes

Avoid destructive decay. Confidence is not the same thing as age; old but
still-valid decisions should be visible, just marked appropriately.
