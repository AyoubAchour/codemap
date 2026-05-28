# Task 071: Benchmark Miss Audit

**Status:** done
**Phase:** Phase 4 / evaluation
**Estimate:** 1 day
**Depends on:** task-070
**Blocks:** future retrieval ranking and semantic-provider tuning

## Goal

Make retrieval benchmark failures directly actionable by grouping the exact
queries, tags, targets, noisy variants, and payload overruns that need follow-up
before changing ranking behavior.

## Context

Tasks 066-070 made retrieval optimization measurable and stabilized the test
gate. Fresh Codemap and Taskflow runs showed the default lexical path is still
healthy, but planning payload pressure and graph/mixed variant noise can be hard
to diagnose from aggregate metrics alone. The next optimization loop needs a
small, deterministic audit packet in the benchmark summary.

## Deliverables

- Per-query `missing` target lists for file and graph-node evaluations.
- Bounded `summary.audit` groups for file misses, node misses, warning misses,
  result-source misses, forbidden hits, variant file misses, variant forbidden
  hits, and payload budget overruns.
- Tag aggregation for benchmark issues so scenario families can be prioritized.
- Next-step guidance that points to `summary.audit` when issues are present.
- Unit coverage for mixed miss/noise/payload audit output.

## Exit Criteria

- [x] Benchmark results report missing expected file/node targets.
- [x] `summary.audit` identifies query ids and tags for misses, noisy variants,
  and payload overruns.
- [x] Audit output is bounded and records whether it was truncated.
- [x] Existing benchmark gates remain unchanged; this task adds diagnosis, not
  retrieval ranking changes.
