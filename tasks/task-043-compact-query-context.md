# Task 043 — Compact query context

Status: todo

Phase: Phase 4 / retrieval

## Intent

Make `query_context` cheaper and easier for agents to consume by adding compact,
tiered response modes.

## Context

`query_context` is the right planning surface, but rich source, dependency, and
impact payloads can grow large. The next slice should keep full detail available
while defaulting agents toward high-signal summaries and explicit expansion
paths.

## Deliverables

- Add `mode` or equivalent options for compact, standard, and full output.
- Return stable summaries first: best graph memories, best source hits, warnings,
  and next actions.
- Provide a clear way to expand selected files/nodes without repeating the full
  query.
- Keep existing callers backward-compatible.

## Exit Criteria

- [ ] Compact mode substantially reduces response size on this repo.
- [ ] Standard/full modes preserve existing planning detail.
- [ ] Tests cover response shape, defaults, and expansion guidance.

