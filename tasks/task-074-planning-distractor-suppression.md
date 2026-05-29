# Task 074: Planning Distractor Suppression

**Status:** done
**Phase:** Phase 4 / retrieval
**Estimate:** 1 day
**Depends on:** task-073
**Blocks:** none

## Goal

Keep weak, wrong-domain source matches out of planning-sized retrieval results while preserving primary hit-rate, payload, and compact recall gates.

## Context

Task 073 added bounded companion context and left primary Codemap benchmark retrieval healthy. Post-merge benchmark triage showed the remaining Codemap suite misses are supporting-file companions, but the Taskflow fixture planning profile still returns two forbidden distractors at low ranks: `src/notifications/email.ts` for an auth/session query and `src/auth/session.ts` for a notification/digest query. The recall profile already keeps these distractors out, so this task should tune planning ranking without adding semantic/vector runtime dependencies.

## Deliverables

- A regression benchmark/test that fails when Taskflow planning retrieval returns forbidden distractors.
- A scoped source-index ranking change that removes weak planning distractors without damaging direct hits, companion context, or recall behavior.
- Verification of Codemap planning/recall gates, Taskflow planning/recall gates, typecheck, tests, build, and whitespace checks.

## Steps

1. Add a failing benchmark regression for the Taskflow planning forbidden-file guardrail.
2. Inspect low-scoring result behavior in `src/source_index.ts`.
3. Tune weak-result filtering or demotion narrowly enough to preserve expected planning context.
4. Run focused tests, full tests, build, `git diff --check`, and retrieval benchmark gates.

## Exit criteria

- [x] Taskflow planning benchmark has `forbidden_violation_rate` 0 and `false_positive_rate_at_k` 0.
- [x] Taskflow recall benchmark remains clean.
- [x] Codemap planning and recall benchmark gates still pass with primary file hit-rate 1 and payload compliance 1.
- [x] `bun run typecheck`, `bun test`, `bun run build`, and `git diff --check` pass.

## Notes

- Do not promote `local-hash` semantic retrieval; the latest experiment still trails lexical recall and exceeds planning payload budget.
- Keep this as a retrieval-quality PR, not a release task.
