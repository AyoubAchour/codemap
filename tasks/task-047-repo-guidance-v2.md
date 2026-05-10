# Task 047 — Repo guidance v2

Status: done

Phase: Phase 4 / onboarding

## Intent

Generate compact, useful repo-area guidance from the source index and curated
graph without confusing generated orientation with durable memory.

## Context

`codemap generate-skills` is useful, but the next version should create smaller
area slices, cite source-index and graph evidence clearly, and tell agents when
to inspect rather than trust.

## Deliverables

- [x] Generate repo-area guidance files from indexed paths, tags, and high-trust
  graph nodes.
- [x] Include freshness metadata and provenance for every generated section.
- [x] Add `--check` coverage for area-level drift.
- [x] Keep generated files under `.codemap/skills/` and clearly separate from
  `.codemap/graph.json`.

## Exit Criteria

- [x] Generated guidance is compact enough for agent skill loading.
- [x] Stale source index or graph memory is visible in generated metadata.
- [x] No generated guidance path writes graph nodes automatically.

## Delivered

- `codemap generate-skills` now writes a compact entrypoint plus per-area
  guidance under `.codemap/skills/codemap-repo/areas/`.
- Each area slice includes provenance, source-index freshness, area hashes,
  high-trust graph memory, and inspect-first warnings for stale or low-trust
  memory.
- `codemap generate-skills --check` compares area hashes and reports added,
  changed, removed, and unchanged areas without writing files.

## Verification

- `bun test test/unit/cli.test.ts --timeout 30000`
- `bun run typecheck`
- `bun run build`
- `bun test --timeout 30000`
