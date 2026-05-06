# Task 042 — Range-aware source anchors

Status: in-progress

Phase: Phase 4 / accuracy

## Intent

Make graph staleness more accurate by distinguishing whole-file drift from
changes to the cited line range. A memory should not become low-trust just
because unrelated code elsewhere in the same file changed.

## Context

Codemap currently verifies `sources[].content_hash` against the full file. That
is safe but too coarse: a one-line import or nearby helper edit can mark many
otherwise-valid findings stale. This task adds a server-filled range hash while
preserving the existing full-file hash for compatibility and tamper checks.

## Deliverables

- Add optional `sources[].range_hash` to the graph schema.
- Fill `range_hash` automatically in `emit_node` after validating the full-file
  `content_hash`.
- Treat full-file drift with unchanged `range_hash` as fresh in staleness checks.
- Report actual cited-range edits separately from legacy full-file hash changes.
- Update docs and tests for the new anchor model.

## Exit Criteria

- [x] Existing graph files without `range_hash` still load and validate.
- [x] New `emit_node` writes persist `range_hash` without requiring agents to
      provide it.
- [x] `graph_health` and `query_graph` keep old full-file behavior for legacy
      anchors.
- [x] A file edit outside the cited range does not mark a range-aware anchor
      stale.
- [x] A file edit inside the cited range reports `anchor_changed`.

## Verification

- `bun run typecheck`
- `bun test test/unit/schema.test.ts test/unit/graph_health.test.ts test/integration/mcp.test.ts`
- `bun test`
- `bun run build`

