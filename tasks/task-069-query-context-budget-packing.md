# Task 069: Query Context Budget Packing

**Status:** done
**Phase:** Phase 4 / retrieval
**Estimate:** 1 day
**Depends on:** task-068
**Blocks:** future planning-context tuning and release bookkeeping

## Goal

Add opt-in byte-budget packing to `query_context` so the larger planning surface
can stay within a caller-supplied response budget without changing default
planning behavior.

## Context

Task 068 made `recall_context` lane-aware and budget-auditable, but
`query_context` still returned the larger planning packet wholesale. The
standard planning benchmark stayed accurate, but a stricter 65 KB payload gate
only passed 6 of 16 queries, with a max response around 79 KB. That means
planning context can still waste agent budget even when the right files are
present.

This task keeps the optimization local and deterministic. It does not add
runtime semantic retrieval, hosted services, LLM summarization, or automatic
graph writes.

## Deliverables

- Optional `budgetBytes` support in shared `buildQueryContext`.
- `budget_bytes` support in the `query_context` MCP tool.
- `codemap context --budget <n>` for humans and CLI-driven agents.
- `codemap benchmark-retrieval --context-budget-bytes <n>` for measuring
  budgeted planning packets separately from payload gates.
- Per-lane `budget.packing` metadata for summary, graph, source, repo map,
  related nodes, expansion, and warnings.
- Focused regression tests for core, CLI, and benchmark wiring.

## Steps

1. Add failing tests for budgeted `query_context`, CLI `context --budget`, and
   benchmark context-budget wiring.
2. Fit budgeted responses by trimming bulky source content first, then source
   dependency/impact detail, repo map detail, related nodes, expansion detail,
   graph match detail, and finally low-ranked source results if required.
3. Preserve default unbudgeted `query_context` output shape.
4. Report packing metadata and an explicit warning when detail is omitted for
   budget.
5. Update docs and benchmark guidance.

## Exit Criteria

- [x] Unbudgeted `query_context` omits budget metadata and keeps existing
      planning detail.
- [x] Budgeted `query_context` reports `budget.packing` and stays within the
      configured byte budget in focused tests.
- [x] CLI and MCP paths share the same core implementation.
- [x] Benchmark runs can opt into budgeted query-context packets without
      changing payload gates.
- [x] Planning benchmark passes a 65 KB response gate when
      `--context-budget-bytes 65000` is supplied.

## Implementation Notes

Budget fitting uses strategy `planning_detail_budget_v1`. It preserves
high-signal summaries, graph/source identities, warnings, and expansion hints
before dropping lower-value detail. Source result content is the first thing
trimmed because it is usually the largest part of the planning packet and does
not affect benchmark file-hit evaluation.

The benchmark surface keeps two separate concepts:

- `--context-budget-bytes` changes the `query_context` packet that is measured.
- `--response-budget-bytes` evaluates whether the measured response fits a gate.

That distinction keeps historical benchmark threshold behavior intact while
making budgeted planning packets measurable.
