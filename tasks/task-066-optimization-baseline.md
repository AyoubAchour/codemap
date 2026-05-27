# Task 066: Optimization Baseline and Coverage Audit

**Status:** done
**Phase:** Phase 4 / evaluation
**Estimate:** 1-2 days
**Depends on:** task-065
**Blocks:** targeted retrieval/ranking optimization work

## Goal

Make Codemap optimization measurable by extending retrieval benchmarks with
agent-accuracy guardrails before changing ranking, semantic retrieval, or
runtime behavior.

## Context

Codemap exists to make agents more accurate and faster during repo work. Task
065 showed the benchmark-only `local-hash` semantic provider is useful as a
comparison point but does not beat lexical recall on the Codemap suite. The next
step is therefore better measurement: false positives, provenance, warnings,
payload, and latency should be visible before tuning the retrieval stack.

## Deliverables

- Benchmark suite fields for forbidden file/node targets.
- Benchmark suite fields for expected provenance warnings and result sources.
- Aggregate guardrail metrics for forbidden-hit rate, warning recall, and
  result-source recall.
- Latency p50/p95 alongside average and max latency.
- Small benchmark-suite additions for agent lifecycle, payload gates, and
  distractor pressure.
- Updated benchmark docs and project handoff/roadmap notes.

## Steps

1. Extend retrieval benchmark parsing and result types.
2. Evaluate expected and forbidden files/nodes per query.
3. Evaluate expected warnings and result-source categories.
4. Add aggregate guardrail metrics and next-step hints.
5. Add focused tests for metric behavior and invalid suite values.
6. Add small benchmark/fixture cases without creating a large corpus.
7. Run baseline commands and record results.

## Exit Criteria

- [x] Existing benchmark suites remain compatible.
- [x] Benchmark results expose false-positive pressure, warning coverage, and
      result-source coverage.
- [x] Latency summary includes p50 and p95.
- [x] Fixture additions stay small and purposeful.
- [x] Baseline results are recorded before follow-up optimization work.

## Implementation Notes

Added optional query fields:

- `forbidden_files`
- `forbidden_nodes`
- `expected_warnings`
- `expected_result_sources`

Expected result sources are evidence categories: `graph`, `source`, `semantic`,
and `reranker`. They describe which retrieval lanes produced evidence, not file
source anchors.

The benchmark summary now reports:

- `forbidden_evaluated_queries`
- `forbidden_violation_rate`
- `false_positive_rate_at_k`
- `warning_expectations`
- `result_sources`
- `latency.p50_latency_ms`
- `latency.p95_latency_ms`

The default Codemap suite now includes provenance and guardrail expectations on
selected cases plus two new optimization queries:

- `agent-lifecycle-writeback`
- `recall-payload-gates`

The taskflow fixture now includes a tiny archived runbook and Slack notification
distractors plus two extra distractor/payload queries. This deliberately keeps
the fixture small while making precision and false-positive pressure visible.

## Baseline Results

Recorded on 2026-05-27.
Commands used `--refresh-index if_stale` after the source index was already
fresh; cold refresh latency should be measured separately before any speed-only
optimization task.

Codemap recall suite:

| Run | Queries | Hit | Precision | Recall | MRR | Forbidden cases | Forbidden violations | Warning recall | Source recall | Payload pass | Avg latency | P95 latency | Avg bytes | Max bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| disabled | 16 | 1.0000 | 0.3000 | 0.5885 | 0.7240 | 4 | 0.0000 | 1.0000 | 1.0000 | 16/16 | 347.0625 ms | 435 ms | 37531 | 44724 |
| local-hash | 16 | 1.0000 | 0.3000 | 0.5885 | 0.7240 | 4 | 0.0000 | 1.0000 | 1.0000 | 16/16 | 326.25 ms | 414 ms | 37531 | 44724 |

Local-vector variant on the local-hash run:

| Queries | Hit | Precision | Recall | MRR | Semantic latency |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 0.8125 | 0.2875 | 0.5625 | 0.6563 | 119.25 ms |

Taskflow fixture recall suite:

| Queries | Hit | Precision | Recall | MRR | Forbidden cases | Forbidden violations | Payload pass | Avg latency | P95 latency | Avg bytes | Max bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | 1.0000 | 0.3500 | 1.0000 | 1.0000 | 5 | 0.6000 | 8/8 | 18.625 ms | 30 ms | 14727 | 15684 |

The fixture false-positive rate is the first concrete optimization signal from
this task: the relevant files are still retrieved, but distractors can consume
the compact context budget. A follow-up ranking/diversity task should inspect
those misses before changing runtime retrieval defaults.

## Notes

This benchmark is still a proxy for agent correctness. It measures whether the
right context and guardrails are available; it does not prove an autonomous
agent will complete an edit correctly. End-to-end scenario evaluation remains a
separate future task.
