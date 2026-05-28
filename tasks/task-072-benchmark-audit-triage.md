# Task 072: Benchmark Audit Triage

**Status:** done
**Phase:** Phase 4 / evaluation
**Estimate:** 1 day
**Depends on:** task-071
**Blocks:** future retrieval ranking and semantic-provider tuning

## Goal

Separate strict retrieval expectations from useful secondary context so benchmark
miss audits identify real must-fix retrieval failures instead of over-broad
suite expectations.

## Context

Task 071 added `summary.audit`, which made remaining benchmark misses visible.
Fresh planning and recall runs showed the lexical path still found the primary
context, while many missing files were adjacent CLI, tool, docs, or test files.
Those files are useful to track, but treating all of them as `expected_files`
made primary recall look worse than the agent-facing behavior.

## Deliverables

- Add `supporting_files` to retrieval benchmark query suites.
- Report per-query and aggregate `supporting_files` evaluation separately from
  primary `files` metrics.
- Add `summary.audit.supporting_file_misses` so secondary misses remain visible.
- Calibrate the bundled Codemap suite so `expected_files` means must-return
  context and `supporting_files` means useful adjacent context.
- Keep runtime retrieval ranking unchanged.

## Exit Criteria

- [x] Primary `summary.audit.file_misses` is empty for the bundled planning
  benchmark gate.
- [x] Primary `summary.audit.file_misses` is empty for the bundled recall
  benchmark gate.
- [x] Secondary misses remain visible under
  `summary.audit.supporting_file_misses`.
- [x] `supporting_files` does not affect `summary.files` hit rate, recall, or
  thresholds.
