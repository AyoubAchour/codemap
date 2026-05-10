# Task 054 — Agentic writeback quality signals

Status: todo

Phase: Phase 4 / memory quality

## Intent

Make curated graph memory explain why it should be trusted by adding richer
quality, utility, and lifecycle signals.

## Context

ByteRover-style memory systems treat curation, provenance, maturity, recency,
and usage as part of memory itself. Codemap already has confidence, freshness,
and trust ranking; the next step is to track how useful a memory has been and
whether it has been confirmed, superseded, or needs review.

## Deliverables

- Add optional quality metadata such as last-used, utility, maturity, confirmed
  by source, and superseded-by signals.
- Make query-time ranking explain these signals clearly.
- Extend writeback suggestions to prefer high-utility durable knowledge.
- Preserve compatibility with existing graph files.

## Exit Criteria

- [ ] Existing graph files load without migration failure.
- [ ] Query results explain memory trust in agent-readable terms.
- [ ] Low-utility or superseded memory is deprioritized without disappearing.

## Notes

Prefer additive metadata over schema churn. The graph must stay reviewable and
diffable.
