# Task 016: Telemetry (`metrics.json`) + `rollup` implementation

**Status:** in-progress (PR open)
**Phase:** M2 — Sprint 2.3
**Estimate:** 2–3 hours
**Depends on:** task-013 (MCP tools), task-014 (emit_node), task-015 (CLI rollup stub)
**Blocks:** task-017 (distribution) — README references opt-out env var

## Goal

Make M3 measurable per V1_SPEC §11. Add lightweight per-turn + weekly-rollup metrics written to `<repoRoot>/.codemap/metrics.json`. Wire all 5 MCP tools to record events. Implement the `codemap rollup` CLI command properly. Add a `CODEMAP_TELEMETRY=false` env-var opt-out for users who don't want metrics in their repo.

This is what makes the M3 trial's "is this actually helping" question answerable beyond pure subjectivity.

## Decisions required

### D1 — `metrics.json` committed or gitignored?

**V1_SPEC §11 default:** committed to git. Rationale: small file, useful diff history, supports team-wide ROI conversations.

**Counter-argument:** committing creates a noisy diff on every emit + every load. If a team has 5 devs each running ~50 turns/day, the file changes 250+ times a day. Also: timestamps in the per-turn entries leak when each dev is active.

**Recommendation: keep committed but write the file in append-only-friendly form** (newest entries first, max 1000 entries before rotation). That gives both clean diffs (most-recent-on-top) and bounded file size. If the dev team finds the noise hurts more than the visibility helps, single line `notes/.gitignore` flip.

### D2 — Telemetry opt-out mechanism

**Choice (recommended): single env var `CODEMAP_TELEMETRY=false`.** Standard pattern (per [GitHub CLI / 2026 dev-tool conventions](https://github.blog/changelog/2026-04-22-github-cli-opt-out-usage-telemetry/)). Also respect `DO_NOT_TRACK=1` as a courtesy (industry-wide convention).

When opted out: tools and CLI proceed normally but `metrics.json` is never read or written.

### D3 — Rollup cadence

**Choice (recommended): lazy on first read, plus on-demand via `codemap rollup`.** Per V1_SPEC §11. No background timer, no cron. `query_graph` is the implicit trigger — when called and the rollup section is older than 7 days, recompute it from the per-turn entries. Cheap because we never have more than ~1000 entries.

Alternative: explicit-only (`codemap rollup` is the only writer). Pros: no implicit work in tools. Cons: manual ritual.

## Context

References:
- `V1_SPEC.md` §11 — telemetry shape.
- `TECH_SPEC.md` §7 — `metrics.json` schema example.
- 2026 industry conventions for CLI telemetry opt-out: `DO_NOT_TRACK`, tool-specific env var, local-file inspection. Codemap's metrics are local-only by design — no network exfiltration concern.

## Deliverables

- `src/metrics.ts` — `MetricsStore` class: `load(repoRoot, options)`, `recordTurn(event)`, `rollupIfStale(now)`, `save()`. Atomic writes via the same `proper-lockfile` pattern as `GraphStore`.
- `src/cli/rollup.ts` (replacing the stub from task-015) — calls `MetricsStore.rollupIfStale(now)` then prints the rollup summary.
- Wire instrumentation into the 5 MCP tool handlers + CLI `validate` (counts repairs found / dropped).
- `test/unit/metrics.test.ts` — schema, atomic write, lazy rollup, env-var opt-out.
- README mention of the opt-out env var (task-017's responsibility, but flag here).
- `.codemap/metrics.json` schema documented in TECH_SPEC §7 already; verify the implementation matches.

## Schema (mirror TECH_SPEC §7)

```json
{
  "version": 1,
  "per_turn": [
    {
      "topic": "<active topic at time of event>",
      "ts": "2026-04-29T...",
      "queries": 0,
      "results_returned": 0,
      "nodes_emitted": 0,
      "collisions_detected": 0,
      "cap_hit": false,
      "stale_rechecks": 0,
      "links_made": 0,
      "validator_repairs": 0
    }
  ],
  "rollup_weekly": [
    {
      "week_of": "2026-04-26",
      "total_nodes": 47,
      "verified_pct_7d": 0.62,
      "knowledge_kind_ratio": 0.34,
      "total_emissions": 18,
      "total_collisions": 4,
      "cap_hits": 1
    }
  ]
}
```

`per_turn` is bounded: max 1000 entries, oldest dropped on push. Newest first (so diffs append at the top, keeping the recent-history range stable).

## Implementation notes

- **One turn = one MCP `set_active_topic` window.** New entry created on `set_active_topic`; subsequent tool calls within that turn increment fields on the most-recent entry. Cap reset (TECH_SPEC §5) is the boundary.
- **`record*` is best-effort.** Telemetry write failures must NOT break the tool call. Wrap in try/catch; log to stderr; continue.
- **Schema is forward-compatible.** Top-level `version` field; future field additions go on entries with sane defaults.
- **No PII.** Counts only. No file paths, no user names, no machine IDs. Topic names are user-chosen slugs and they're already in graph.json — no new exposure.
- **Rollup boundary:** ISO week (Monday-anchored). Current week is always present and ongoing; finalize on week boundary.

## Wiring per tool

| Tool | What it records |
|---|---|
| `set_active_topic` | Starts a new per-turn entry. |
| `query_graph` | `queries++`; `results_returned += len(result.nodes)`; `stale_rechecks += <implementation TBD per future verification logic>`. |
| `get_node` | (no counters; or maybe a `get_node_calls` field if useful for retrieval-quality analysis later — defer for v1). |
| `emit_node` (success) | `nodes_emitted++`. |
| `emit_node` (collision response) | `collisions_detected++`. |
| `emit_node` (capped) | `cap_hit = true`. |
| `link` (success) | `links_made++`. |
| `validate` (CLI) | `validator_repairs += <count>`. |

Per V1_SPEC §11 the metrics aren't intended to drive any production behavior — only M3 observability.

## Test plan

- Empty `metrics.json` → bootstrap on first write.
- Per-turn entry created on `set_active_topic`; subsequent emits increment the same entry.
- 5 emits + 1 capped → entry shows `nodes_emitted: 5, cap_hit: true`.
- 1001st turn entry → 1st entry dropped; max length 1000 sustained.
- Rollup on a week-boundary tick → rollup_weekly section appended; per_turn entries from prior week summarized.
- `CODEMAP_TELEMETRY=false` → no read, no write, no file created.
- `DO_NOT_TRACK=1` → same.
- Atomic save: SIGKILL during write leaves a valid file (or untouched).

## Exit criteria

- [ ] `src/metrics.ts` ships with the documented API.
- [ ] All 5 MCP tools record events when telemetry is on.
- [ ] `codemap rollup` runs the rollup and prints a summary.
- [ ] Opt-out via `CODEMAP_TELEMETRY=false` and `DO_NOT_TRACK=1`.
- [ ] All telemetry tests pass.
- [ ] CI green.

## Notes

- Don't add network telemetry. Local-only is the v1 design and the M3 measurement need.
- Telemetry on `link` success (and the equivalent CLI mutations) is added as a later mini-task if M3 reveals the existing counters miss something useful.
