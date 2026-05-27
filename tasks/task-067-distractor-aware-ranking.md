# Task 067: Distractor-Aware Source Ranking

**Status:** done
**Phase:** Phase 4 / retrieval
**Estimate:** 1-2 days
**Depends on:** task-066
**Blocks:** future context-packing and runtime recall tuning

## Goal

Reduce irrelevant source hits in compact retrieval without adding semantic
runtime dependencies or weakening recall.

## Context

Task 066 made optimization measurable and showed the first concrete miss:
the Taskflow fixture retrieved every expected file, but archived docs and
standalone Slack notification helpers still consumed compact source-result
budget. The local-hash semantic experiment from task 065 did not beat lexical
recall, so the next fix should tune local lexical/source ranking first.

## Deliverables

- Stop-word filtered query tokens for source-search BM25 and structured-field
  boosts.
- Structured token matching for path, symbol, import, export, and related-node
  reasons so short tokens such as `if` do not match substrings inside
  `notifications`.
- Archive/deprecated/legacy demotion unless the query explicitly asks for that
  material.
- Disconnected-file demotion for change/impact/review queries, preserving files
  named explicitly by the query.
- A weak-score floor so demoted distractors do not refill compact context just
  because a limit has spare slots.
- Unit and benchmark regression coverage for the Taskflow false-positive case.

## Steps

1. Reproduce the Taskflow fixture false-positive rate from task 066.
2. Add failing source-index tests for stop-word substring boosts, archive-like
   docs, and disconnected impact-query files.
3. Add a benchmark regression for the Taskflow compact recall guardrail.
4. Implement the smallest lexical ranking changes that reduce distractors.
5. Re-run the Taskflow and Codemap recall benchmark suites.
6. Update docs with the implemented behavior and measured results.

## Exit Criteria

- [x] Taskflow fixture forbidden violation rate drops below the task 066
      baseline of `0.6000`.
- [x] Taskflow fixture keeps hit rate, recall, and MRR at `1.0000`.
- [x] Codemap recall suite does not regress on forbidden violations or payload
      compliance.
- [x] Runtime semantic retrieval remains disabled; local-hash remains
      benchmark-only.
- [x] Focused tests cover the ranking behavior.

## Implementation Notes

The source-index search path now filters common query stop words before BM25 and
structured-field scoring. Structured boosts use tokenized path/symbol/import/
export text instead of arbitrary substrings, which prevents matches such as the
query token `if` boosting `src/notifications/email.ts`.

Ranking also applies small deterministic demotions:

- archive-like paths or content are heavily demoted unless the query includes an
  archive/deprecated/legacy token;
- implementation review queries demote source files with no local imports or
  importers, unless the query names the file stem directly;
- very weak post-demotion hits are filtered before diversity selection.

These are local lexical heuristics. They do not introduce a semantic provider,
hosted service, graph schema change, or automatic graph write.

## Results

Recorded on 2026-05-27 with `--profile recall --refresh-index if_stale`.

Taskflow fixture:

| Metric | Task 066 baseline | Task 067 |
| --- | ---: | ---: |
| Queries | 8 | 8 |
| Hit | 1.0000 | 1.0000 |
| Precision | 0.3500 | 0.3854 |
| Recall | 1.0000 | 1.0000 |
| MRR | 1.0000 | 1.0000 |
| Forbidden violations | 0.6000 | 0.0000 |
| False positive rate at K | 0.1200 | 0.0000 |
| Payload pass | 8/8 | 8/8 |

Codemap recall suite:

| Metric | Task 066 baseline | Task 067 |
| --- | ---: | ---: |
| Queries | 16 | 16 |
| Hit | 1.0000 | 1.0000 |
| Precision | 0.3000 | 0.3250 |
| Recall | 0.5885 | 0.6406 |
| MRR | 0.7240 | 0.7625 |
| Forbidden violations | 0.0000 | 0.0000 |
| Payload pass | 16/16 | 16/16 |

Local-hash remains benchmark-only. On the Codemap suite after this change, the
local-vector variant still does not beat lexical retrieval: hit `0.8125`,
precision `0.2875`, recall `0.5625`, MRR `0.6563`.

## Notes

The next optimization slice should inspect context packing across graph, source,
repo-map, and capture-summary evidence. Task 067 improves source ranking, but it
does not yet decide how a compact response should spend budget across evidence
lanes.
