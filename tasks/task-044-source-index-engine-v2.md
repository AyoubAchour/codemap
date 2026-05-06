# Task 044 — Source index engine v2

Status: todo

Phase: Phase 4 / performance

## Intent

Make local source discovery faster and more scalable by persisting search-ready
index structures instead of rebuilding ranking data on every query.

## Context

The current source index stores chunks, symbols, imports, and exports, then
computes ranking structures at query time. That is acceptable on small repos but
will become wasteful on larger codebases and repeated agent turns.

## Deliverables

- Persist token statistics or an inverted index alongside chunks.
- Cache/load search-ready snapshots with freshness checks.
- Add timing and result-count regression tests.
- Keep `.codemap/index` rebuildable and safe to delete.

## Exit Criteria

- [ ] Repeated source searches avoid re-tokenizing every chunk.
- [ ] `get_index_status` remains lightweight.
- [ ] Search results stay deterministic and backward-compatible.

