# Task 048 — Hybrid retrieval evaluation

Status: done

Phase: Phase 4 / retrieval

## Intent

Decide whether embeddings or reranking are worth adding by measuring real local
retrieval misses first.

## Context

Hybrid search is attractive, but Codemap should not add hosted dependencies or
large local model complexity until lexical, symbol, and graph-quality signals
have been measured on real tasks.

## Deliverables

- Add a small retrieval benchmark harness using repo-local queries and expected
  files/nodes.
- Track precision, diversity, latency, and response size.
- Prototype optional pluggable embeddings or reranking behind an off-by-default
  interface only if benchmarks show lexical misses.

## Exit Criteria

- [x] Benchmarks run locally without network access.
- [x] Current lexical/symbol retrieval has baseline metrics.
- [x] Any embedding/reranker prototype is optional and disabled by default.

## Delivered

- Added `src/retrieval_benchmark.ts`, a local benchmark harness that runs
  repo-owned query suites through `query_context`.
- Added `codemap benchmark-retrieval`, which reports hit rate, precision@K,
  recall@K, MRR, source-file diversity, latency, response size, and threshold
  pass/fail status.
- Added `benchmarks/retrieval.codemap.json` as the Codemap repo's baseline
  file-retrieval suite.
- Added tests covering file metrics, node metrics, threshold failures, suite
  validation, and the CLI wrapper.

## Baseline

Command:

```sh
bun run bin/codemap.ts benchmark-retrieval --refresh-index if_stale --limit 10 --min-file-hit-rate 0.8
```

Results on 2026-05-10:

- suite queries: 6
- files hit_rate_at_k: 1.0
- files precision_at_k: 0.2333
- files recall_at_k: 0.9445
- files MRR: 1.0
- average source-file diversity: 1.0
- average latency: 508.5ms
- average response size: 90,345 bytes

No embeddings or rerankers were added. The benchmark records them as disabled
until baseline misses justify a separate optional retrieval strategy.
