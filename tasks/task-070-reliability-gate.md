# Task 070: Reliability Gate

**Status:** done
**Phase:** Phase 4 / evaluation
**Estimate:** 1 day
**Depends on:** task-069
**Blocks:** future retrieval tuning and release bookkeeping

## Goal

Make the full test and benchmark gate reliable after the task 066-069
optimization sequence, especially on Windows where platform-specific filesystem
and signal behavior can hide or invent failures.

## Context

Tasks 066-069 added the measurement and budget surfaces needed for
accuracy-oriented optimization. Before tuning more ranking behavior, the test
suite itself needs to be trustworthy. The known failures were concentrated in
CLI coverage for watch refresh failures, live watch interruption, and generated
repo guidance path output.

This task should keep runtime behavior conservative. Fix product bugs when the
test exposes one, but avoid ranking or benchmark-threshold changes unless a
fresh failure proves they are needed.

## Deliverables

- Deterministic watch-mode refresh-failure coverage that does not depend on
  platform-specific chmod behavior.
- Deterministic live-watch abort coverage that does not depend on child-process
  signal reporting differences.
- Repo-style generated guidance paths in JSON responses on all platforms.
- Full test, typecheck, and build verification from a clean task branch.

## Steps

1. Reproduce the known failing CLI tests from `test/unit/cli.test.ts`.
2. Replace brittle test setup with deterministic filesystem or abort signals.
3. Normalize generated repo guidance response paths at the API boundary.
4. Run focused CLI tests, then the full test/typecheck/build gate.
5. Update task and changelog notes with the verified outcome.

## Exit Criteria

- [x] The focused CLI regression tests pass.
- [x] `bun test test/unit/cli.test.ts` passes.
- [x] Full `bun test` passes.
- [x] `bun run typecheck` passes.
- [x] `bun run build` passes.
- [x] Generated repo guidance JSON reports repo-relative `/` paths on Windows.

## Notes

Do not treat process signal exit codes as portable evidence on Windows. Prefer
direct abort-signal coverage for live watcher shutdown semantics.
