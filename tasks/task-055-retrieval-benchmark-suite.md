# Task 055 — Larger retrieval benchmark suite

Status: todo

Phase: Phase 4 / evaluation

## Intent

Expand Codemap's benchmark coverage before adding semantic retrieval, graph
ranking, or watcher complexity.

## Context

The current six-query suite is useful but too small. It proves the local
retrieval path works on happy-path Codemap queries, not that Codemap can handle
semantic wording, typos, renamed symbols, stale graph memory, docs/tests
discovery, or multi-repo fixtures.

## Deliverables

- Add semantic and typo-heavy query cases.
- Add cross-file impact, renamed symbol, stale graph, docs, and tests cases.
- Add at least one fixture repo beyond Codemap.
- Track latency, response size, diversity, precision, recall, MRR, and
  threshold regressions.

## Exit Criteria

- [ ] Benchmark failures point to specific retrieval weaknesses.
- [ ] Optional semantic/rerank experiments can be compared against the same
      suite.
- [ ] The suite is documented enough for contributors to add new cases.

## Notes

This task should happen before task 052 so retrieval complexity follows
evidence rather than taste.
