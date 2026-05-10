# Task 052 — Optional semantic retrieval layer

Status: todo

Phase: Phase 4 / retrieval

## Intent

Add an optional local-first semantic retrieval adapter without making cloud
embeddings, vector databases, or rerankers part of the default Codemap runtime.

## Context

DeepContext, Viberag, and Vera show the value of hybrid retrieval: BM25 plus
embeddings and reranking. Codemap should borrow the architecture only when the
benchmark suite proves lexical/symbol retrieval misses real tasks.

## Deliverables

- Define an adapter interface for embeddings and rerankers.
- Keep all semantic retrieval disabled by default.
- Support local-first providers before cloud providers.
- Gate semantic/rerank experiments behind `benchmark-retrieval`.

## Exit Criteria

- [ ] Default install remains local-only with no network calls.
- [ ] Semantic retrieval can be benchmarked independently from BM25.
- [ ] Any cloud provider integration is opt-in and visibly reported.

## Notes

Do not add hosted dependencies until task 055 exposes benchmark misses that
justify them.
