# Task 052 — Optional semantic retrieval layer

Status: done

Phase: Phase 4 / retrieval

## Intent

Add an optional local-first semantic retrieval adapter without making cloud
embeddings, vector databases, or rerankers part of the default Codemap runtime.

## Context

DeepContext, Viberag, and Vera show the value of hybrid retrieval: BM25 plus
embeddings and reranking. Codemap should borrow the architecture only when the
benchmark suite proves lexical/symbol retrieval misses real tasks.

## Deliverables

- Defined adapter interfaces for file-level semantic retrieval and reranking.
- Kept semantic retrieval and reranking disabled by default.
- Added programmatic benchmark support for injected local/cloud/custom file
  retrieval adapters without adding provider dependencies.
- Gated semantic/rerank provider selection behind `benchmark-retrieval`; the
  current CLI build only accepts `disabled`.

## Exit Criteria

- [x] Default install remains local-only with no network calls.
- [x] Semantic retrieval can be benchmarked independently from BM25.
- [x] Any cloud provider integration is opt-in and visibly reported.

## Notes

No hosted dependencies were added. Future provider work should start with a
local adapter and only add a cloud provider after benchmark evidence justifies
the runtime and privacy tradeoff.
