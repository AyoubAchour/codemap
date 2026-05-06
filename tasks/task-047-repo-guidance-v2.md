# Task 047 — Repo guidance v2

Status: todo

Phase: Phase 4 / onboarding

## Intent

Generate compact, useful repo-area guidance from the source index and curated
graph without confusing generated orientation with durable memory.

## Context

`codemap generate-skills` is useful, but the next version should create smaller
area slices, cite source-index and graph evidence clearly, and tell agents when
to inspect rather than trust.

## Deliverables

- Generate repo-area guidance files from indexed paths, tags, and high-trust
  graph nodes.
- Include freshness metadata and provenance for every generated section.
- Add `--check` coverage for area-level drift.
- Keep generated files under `.codemap/skills/` and clearly separate from
  `.codemap/graph.json`.

## Exit Criteria

- [ ] Generated guidance is compact enough for agent skill loading.
- [ ] Stale source index or graph memory is visible in generated metadata.
- [ ] No generated guidance path writes graph nodes automatically.

