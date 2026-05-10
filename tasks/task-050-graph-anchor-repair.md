# Task 050 — Graph re-anchoring and memory repair

Status: done

Phase: Phase 4 / memory quality

## Intent

Turn stale graph-health findings into concrete repair proposals so agents can
refresh, re-anchor, or deprecate curated memory without guessing.

## Context

Dogfooding shows Codemap's source index can be fresh while many curated graph
anchors are stale. That is dangerous because stale graph memory can look more
authoritative than source-index hints. Range-aware anchors already distinguish
range drift from full-file drift, but agents still need an explicit repair
workflow.

## Deliverables

- Add a read-only repair analysis surface that groups stale anchors into
  actionable proposals.
- Detect range-unchanged anchors that can be refreshed safely after inspection.
- Identify legacy full-file anchors and suggest range-aware replacements.
- Identify changed/missing/unsafe/read-error anchors that need review,
  deprecation, or re-anchoring.
- Expose the analysis through CLI and MCP without mutating graph memory.

## Exit Criteria

- [x] Repair proposals include current hashes and replacement source anchors
      when the source file is readable.
- [x] Legacy anchors are clearly marked so agents know they need re-anchoring.
- [x] Range-unchanged anchors are separated from changed-range anchors.
- [x] CLI and MCP surfaces are read-only and tested.

## Delivered

- Added `inspectGraphRepair`, a read-only analyzer that classifies source
  anchors into refresh, review, legacy re-anchor, deprecate/re-anchor, unsafe,
  and read-error proposals.
- Added `codemap repair-graph` and `codemap repair-graph --json`.
- Added the `graph_repair` MCP tool for agent-facing repair proposals.
- Updated generated lifecycle guidance so agents call `graph_repair` after
  `graph_health` reports stale or legacy anchors.
- Added unit, CLI, and MCP integration coverage.

## Verification

- `bun test test/unit/graph_repair.test.ts --timeout 30000`
- `bun test test/unit/cli.test.ts --timeout 30000`
- `bun test test/integration/mcp.test.ts --timeout 30000`

## Notes

Write-side auto-repair is intentionally deferred. This slice makes the correct
repair obvious while preserving human/agent review before changing durable
memory.
