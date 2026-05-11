# Task 054 — Agentic writeback quality signals

Status: done

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

- [x] Existing graph files load without migration failure.
- [x] Query results explain memory trust in agent-readable terms.
- [x] Low-utility or superseded memory is deprioritized without disappearing.

## Notes

Prefer additive metadata over schema churn. The graph must stay reviewable and
diffable.

Implemented in this slice:

- `NodeSchema` accepts optional `quality` metadata:
  `utility_score`, `maturity`, `last_used_at`, `confirmed_by_source`, and
  `superseded_by`.
- `emit_node` auto-populates confirmed source-backed quality metadata for new
  writes while preserving existing quality metadata on merges. Agents can pass
  an optional `quality` patch to rehabilitate superseded memory and clear
  `superseded_by` with `null`.
- `query_graph` and `query_context` expose `quality.signals` and richer
  `quality.reasons`.
- `suggest_writeback` quality-ranks related memories before suggesting links or
  new captures, and stale related-memory ids use that same ranked evidence
  scope.
