# Task 048 — Hybrid retrieval evaluation

Status: todo

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

- [ ] Benchmarks run locally without network access.
- [ ] Current lexical/symbol retrieval has baseline metrics.
- [ ] Any embedding/reranker prototype is optional and disabled by default.

