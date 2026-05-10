# Task 051 — Repo map and symbol graph ranking

Status: todo

Phase: Phase 4 / retrieval

## Intent

Build a lightweight automatic repo map over files, symbols, imports,
references, tests, and docs, then use graph ranking to improve agent context.

## Context

Aider's repo map and GitNexus-style precomputed context show that agents get
better results when file and symbol importance is computed before the LLM asks
follow-up questions. Codemap already indexes symbols/imports/references; the
next step is to turn that source-index data into a ranking layer.

## Deliverables

- Build a source-index-derived file/symbol graph.
- Add centrality/PageRank-style scoring for important files and definitions.
- Use ranking in `query_context`, `changes_context`, and generated repo
  guidance.
- Keep the automatic repo map separate from curated graph memory.

## Exit Criteria

- [ ] Repo map ranking is deterministic and local-only.
- [ ] Ranked context improves benchmark results or reduces response size.
- [ ] Generated guidance highlights high-centrality areas without treating them
      as durable graph memory.

## Notes

Start TS/JS-first using existing source-index references. Multi-language graph
expansion can follow after the ranking model proves useful.
