# Task 058: Recall Benchmark Parity

**Status:** done
**Phase:** Phase 4 / evaluation
**Estimate:** 2-3 days
**Depends on:** task-057, task-055
**Blocks:** task-059, task-065

## Goal

Measure compact recall quality, latency, and payload size before adding new
runtime recall or semantic behavior.

## Context

Agentmemory's strongest quality story is benchmarked top-K recall and token
savings. Codemap's current benchmark suite measures fused repo planning context,
which is intentionally larger and not directly comparable.

## Deliverables

- Recall-focused benchmark cases separate from full `query_context` planning.
- Metrics for recall@K, MRR, precision/recall, diversity, latency, response
  bytes, and budget compliance.
- Baselines for graph-only, source-only, and mixed local retrieval.
- Documented thresholds that future retrieval changes must not regress.

## Steps

1. Add or extend benchmark fixtures for compact recall cases.
2. Extend `src/retrieval_benchmark.ts` with recall and payload-budget metrics.
3. Add CLI output for the new metrics.
4. Add unit tests for metric calculations and threshold failures.
5. Run the suite on the current repo and record the baseline.

## Exit Criteria

- [x] Benchmark output clearly separates compact recall from full planning
      context.
- [x] Latency and response-byte budgets are reported.
- [x] Optional semantic/rerank experiments can reuse the same cases.
- [x] Tests fail on metric regressions.

## Notes

This task should land before `recall_context` so implementation follows measured
needs instead of copying Agentmemory's shape blindly.

## Implementation Notes

Implemented a benchmark `profile` option:

- `planning` keeps the existing full `query_context` benchmark defaults.
- `recall` uses compact, smaller-payload defaults: limit 5, compact mode, and
  120 max content characters unless explicitly overridden.

Added payload and latency gates:

- per-query `payload` details with response bytes, optional budget, budget pass,
  and over-budget bytes
- aggregate `payload_budget` summary with compliance rate, max response bytes,
  and max over-budget bytes
- aggregate `latency` summary with average and max latency
- CLI flags for `--response-budget-bytes`,
  `--min-payload-budget-compliance`, `--max-average-response-bytes`, and
  `--max-average-latency-ms`

Live baseline on 2026-05-16:

- `bun run bin/codemap.ts benchmark-retrieval --profile recall --refresh-index if_stale --response-budget-bytes 50000 --min-payload-budget-compliance 1`
  failed as intended: 14 queries, average response about 52.5 KB, max response
  about 60.9 KB, budget compliance 5/14.
- `bun run bin/codemap.ts benchmark-retrieval --profile recall --refresh-index if_stale --response-budget-bytes 65000 --min-payload-budget-compliance 1`
  passed: 14 queries, file hit rate 1.0, precision 0.3429, recall 0.6845, MRR
  0.875, average latency about 206 ms, max latency about 241 ms, and 14/14
  payload-budget compliance.

Verification:

- `bun run typecheck`
- `bun test`
- `bun test test/unit/retrieval_benchmark.test.ts test/unit/cli.test.ts`
- `bun run bin/codemap.ts benchmark-retrieval --refresh-index if_stale`
