# Task 022: emit_node tag-hygiene + timestamp-guidance tightening (v0.2.0)

**Status:** in-progress
**Phase:** M3 / Sprint 3a → v0.2.0 (bundled with task-021)
**Estimate:** 15 minutes
**Depends on:** task-020 (M3a retro identifying F4 + F5)

## Goal

Tighten two `emit_node` description fields so the M3a-observed quirks (tag inflation, made-up timestamps) self-correct without breaking change.

## The two findings (verbatim from task-020)

- **F4** — *Tag inflation: agent uses kind names ("gotcha") and meta-categories as tags* → 30+ topics auto-created from tags. Each new tag triggers a new topic auto-create in `upsertNode`, bloating the `topics{}` map.
- **F5** — *Agent invented round-number future timestamps (P1)* — e.g. `14:30:00Z` when actual time was `13:10:55Z`. Schema accepts (well-formed ISO); semantics off (not actually current).

## Fixes

| Field | Now | After |
| --- | --- | --- |
| `emit_node.tags` description | (none / no `.describe()`) | `"Domain slugs (e.g. 'auth', 'payments', 'mobile'), 1-5 per node. NOT kind names — kind is a separate field. NOT meta-categories like 'gotcha' or 'todo'. Tags become topics for cross-cutting search."` |
| `emit_node.last_verified_at` description | `"ISO 8601 datetime, e.g. 2026-05-01T12:00:00Z. Validated at runtime."` | `"Current ISO 8601 UTC timestamp at the moment of emission (e.g. 2026-05-01T12:00:00Z). Use the actual current moment, not a round-number or future value."` |

That's it. Two `.describe()` string updates; no behavior change to validation.

## Why this is enough

Both quirks are M3a-observed agent behaviors that respond to clearer tool-description guidance (per task-018's same hypothesis: tool descriptions reach the agent's tool-considering layer reliably). Stricter validation (e.g. rejecting tags that match kind names, or comparing timestamps to system clock) is heavier and could reject legitimate edge cases. Description tightening is cheap and reversible.

## Deliverables

- `src/tools/emit_node.ts` — update the two `.describe()` strings.
- `test/integration/mcp.test.ts` — add 2 tests:
  - `tools/list` output for `emit_node` shows the new `tags` description
  - `tools/list` output for `emit_node` shows the new `last_verified_at` description (still no `pattern` field — task-019 contract preserved)

## Exit criteria

- [ ] Two description strings updated.
- [ ] New tests pass; existing 246 still pass.
- [ ] Manual `tools/list` shows the new descriptions.
- [ ] Schema size doesn't regress (no new patterns added).

## Notes

- If F4 / F5 persist in M3b trial after this patch, we'll need stronger measures (validation-level rejection or a runtime warning). Description-tightening is the lightest first attempt.
