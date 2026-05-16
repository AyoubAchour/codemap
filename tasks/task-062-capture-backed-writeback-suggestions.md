# Task 062: Capture-Backed Writeback Suggestions

**Status:** done
**Phase:** Phase 4 / memory quality
**Estimate:** 2-4 days
**Depends on:** task-060, task-059
**Blocks:** task-063, task-064

## Goal

Use captured session evidence to make `suggest_writeback` more accurate while
keeping it read-only.

## Context

Task 038 added read-only workflow writeback suggestions. Capture events can make
those suggestions better because they preserve files inspected, files modified,
recall hits, and tool activity even when the agent forgets to pass those lists
manually.

## Deliverables

- `suggest_writeback` input support for a capture session id or latest-session
  evidence.
- Candidate source anchors derived from capture events.
- Noise controls so trivial or repeated events do not spam suggestions.
- Tests proving no suggestions path emits graph nodes.

## Steps

1. Load relevant capture evidence in `src/writeback_suggestions.ts`.
2. Rank source candidates from captured files, modified files, recall hits, and
   existing graph staleness.
3. Group suggestions by decision, invariant, gotcha, and relationship.
4. Add tests for useful evidence, noisy evidence, and no-evidence cases.
5. Update CLI/MCP docs.

## Exit Criteria

- [x] Captured evidence improves suggestions without requiring explicit file
      lists.
- [x] Suggestions remain prompts for judgment, not durable memory.
- [x] Repeated low-value events are ignored or collapsed.
- [x] Tests prove graph memory is unchanged.

## Notes

This is the highest-risk quality step. If suggestions get noisy, stop and tune
ranking before adding more capture sources.

Delivered in this task:

- `suggest_writeback` accepts `capture_session_id` / latest-session evidence in
  MCP and `--capture-session` / `--latest-capture-session` in the CLI.
- Captured `file_inspected`, `file_modified`, and `recall_hit` anchors feed
  writeback source candidates with explicit captured-file reasons.
- Repeated captured file evidence collapses through the existing source-candidate
  map instead of creating duplicate suggestions.
