# Task 065: Local Semantic Provider Experiment

**Status:** todo
**Phase:** Phase 4 / retrieval
**Estimate:** 4-7 days
**Depends on:** task-058, task-059

## Goal

Test whether a bundled local embedding provider materially improves compact
recall quality enough to justify opt-in runtime support.

## Context

Agentmemory reports a large R@5 improvement from BM25-only to BM25+vector on
LongMemEval-S. Codemap already has semantic retrieval adapters, but providers
are disabled by default and benchmark-only. The next step is evidence, not a
default dependency.

## Deliverables

- A local embedding provider behind the existing semantic retrieval adapter
  interface.
- Benchmark wiring that compares lexical-only, graph-only, mixed, and
  local-vector variants.
- Install/runtime cost notes.
- Recommendation on whether to keep it benchmark-only, ship as opt-in, or drop
  it.

## Steps

1. Pick a local provider that works on Linux without API keys.
2. Wire it into benchmark-only provider selection.
3. Run the recall benchmark from task 058.
4. Compare recall quality, latency, storage, install size, and failure modes.
5. Record the recommendation in the task file and docs.

## Exit Criteria

- [ ] Default Codemap install remains local-only and no-hosted-service.
- [ ] Provider use is explicit and visibly reported.
- [ ] Benchmark results show whether quality gains justify the cost.
- [ ] Runtime enablement is deferred unless evidence is strong.

## Notes

This task exists to avoid cargo-culting Agentmemory's vector path. If lexical
and graph recall are already good enough, do not ship extra dependency weight.
