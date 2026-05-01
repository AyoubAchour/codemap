# Task 020: M3a Retrospective

**Status:** done (this file IS the deliverable — the retro)
**Phase:** M3 / Sprint 3a wrap-up
**Depends on:** task-018 (v0.1.1), task-019 (v0.1.2), 6 trial prompts run against voice2work
**Drives:** task-021 (`codemap init`), task-022 (tag/timestamp hygiene), v0.2.0 release

## Setup

- **Target codebase:** voice2work (Next.js 16 + Supabase + Google Calendar). User is admin.
- **Agent:** Codex Desktop (Linux), `gpt-5.5` w/ `model_reasoning_effort = "xhigh"`, `codex-cli 0.128.0`.
- **Codemap MCP** wired via `~/.codex/config.toml` `[mcp_servers.codemap]` block.
- **Trial dates:** 2026-05-01.
- **Versions exercised:** v0.1.0 → v0.1.1 → v0.1.2 (with Greptile P1 patch).

## The 6 prompts (per-turn scorecard)

| | Prompt slug | Q→Results | Emit | Cap | Links | Behavioral signal |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | `auth-walkthrough` (cold) | 1→1 | 5 | ✅ | 2 | Cold start: agent built auth domain from scratch; cap fired (more findings than budget) |
| P2 | `session-token-validation` (warm) | 1→4 | **1** | — | 1 | Dedup: agent reused 4 existing nodes, captured only the missing piece (mobile bearer auth) |
| P3 | `trace-calendar-meeting` | 1→5 | 5 | — | **4** | Cross-cutting: 4 edges, used `contradicts` to surface calendar↔custom-events architectural gap |
| P4 | `external-api-rate-limits` | 1→10 | 5 | ✅ | 2 | Ambiguous: query saturated; surfaced `mirrors` cross-provider defect (Resend↔Stripe) |
| P5 | `src-top-level-summary` | 1→10 | **2** | — (refused) | 1 | Adversarial cap test: agent refused to spam, compressed 10+ dirs into 2 structural nodes |
| P6 | `calendar-sync-500-investigation` | 1→10 | 2 | — | 1 | Knowledge + planning: agent challenged prompt premise, used existing graph as anchor |

**Final graph state:** 17 nodes / 11 edges across 5 problem domains (auth web/mobile, voice→schedules, google calendar OAuth+sync+retry, external-API rate-limit defects, src structural map). 6 turns × ~3 min each ≈ 20 min of agent work.

## Codemap protocol patches (the v0.1.x story)

| Version | Change | Result |
| --- | --- | --- |
| v0.1.0 | Initial 5 tools shipped via npm | Agent ignored writeback. **0 emissions on P1 (original)** |
| v0.1.1 | `server.instructions` + tightened tool descriptions | **No effect** — Codex Desktop drops `server.instructions`. **H_A confirmed.** |
| v0.1.1 + AGENTS.md | Same lifecycle policy in voice2work/AGENTS.md | Agent tried writeback, but `emit_node` was missing from its tool view |
| v0.1.2 | `z.iso.datetime()` → string + runtime validation; `z.tuple` → `z.array.length(2)` | All 5 tools surfaced. **Writeback chain works end-to-end.** |
| v0.1.2 + Greptile P1 | Strict `ISO_8601_UTC` regex matches `z.iso.datetime()` exactly | Closed Date.parse data-corruption gap |

**Upshot:** two protocol-level fixes were necessary for OpenAI-class clients. Schema strictness via Zod's `z.iso.datetime()` is incompatible with OpenAI's function-call subset; complex regex patterns trip their sandboxed validator. Tuples vs uniform arrays matter too.

## What worked

| Behavior | Evidence |
| --- | --- |
| **Knowledge-first emission** | 8 invariants + 8 gotchas + 1 flow + 0 file/symbol/package nodes. V1_SPEC §6 priority honored without per-prompt reminders. |
| **Cap discipline holds adversarially** | Cap hit twice (P1 cold + P4 ambiguous) — both legitimate. P5 invited cap-busting via topic spam; agent refused. |
| **Cross-turn stitching** | P6 re-emitted P3's `job-sync-unwired` to add tags. Graph evolves, doesn't just accrete. |
| **Edge-kind discipline** | 3 distinct semantic kinds (`depends_on`, `mirrors`, `contradicts`); zero invented kinds; zero mechanical `imports`/`calls`. |
| **Cross-cutting findings surfaced** | P3's `contradicts` (calendar-sync ↔ custom-events parallel paths). P4's `mirrors` (Resend ↔ Stripe idempotency defect). Both real architectural insights only visible when both nodes are held side-by-side. |
| **Dedup** | 0 collisions across 6 turns / 17 nodes. ID slug discipline + collision detector held perfectly. |
| **Validation** | 0 validator repairs. All emitted graphs were schema-clean. |

## What didn't / open M3a findings

| # | Finding | Severity | Action (follow-on task) |
| --- | --- | --- | --- |
| F1 | Codex Desktop drops MCP `server.instructions` | High | task-021 (`codemap init` auto-generates AGENTS.md/CLAUDE.md) |
| F2 | 0 `decision`-kind emissions across 6 prompts | Medium | M3b: explicit "why did we choose X" prompt |
| F3 | `derived_from`, `replaces`, `implements` edge kinds unexercised | Low | M3b: refactor-style prompts |
| F4 | Tag inflation: agent uses kind names ("gotcha") and meta-categories as tags → 30+ topics | Low | task-022 (tighten emit_node tag description) |
| F5 | Agent invented round-number future timestamps (P1) | Low | task-022 (tighten emit_node `last_verified_at` description) |
| F6 | Retry/offline behavior not tested | Out of scope | M4 reliability work |

## v0.2 task list (output of this retro)

1. **task-021** — `codemap init` CLI command. Auto-generates `AGENTS.md` (and optionally `CLAUDE.md`) from a single source-of-truth template based on `SERVER_INSTRUCTIONS`. Solves F1.
2. **task-022** — Bundle: tag-hygiene + timestamp-guidance description tightening on `emit_node`. Solves F4 + F5.
3. **task-023** *(post-merge, will be drafted later)* — M3b prompt set: 4 prompts targeting `decision`-kind nodes + `derived_from`/`replaces`/`implements` edges. Plus the trial v5 isolation retest of P1 (with AGENTS.md deleted) once `codemap init` ships.

## My honest take

M3a is a clear validation of the Codemap thesis. Six prompts produced a coherent, queryable knowledge graph that meaningfully reduced re-exploration cost (P2 was 5× cheaper than P1 in emissions; P3, P4, P6 reused existing nodes as starting points). The agent honored the lifecycle, the cap, the kind priority, and the dedup discipline — all autonomously.

The protocol-level fixes (server.instructions, schema shrink) appear necessary not just for Codex Desktop but for any OpenAI-class client that sandboxes JSON Schema. Those fixes generalize.

The core hypothesis holds: an MCP-exposed knowledge graph with strong tool descriptions + lifecycle policy can convert ad-hoc agent exploration into permanent team-readable memory.

## Notes

- Initial-publish friction (npm token / 2FA / provenance) added ~2 hours of meta-work outside the trial scope. Worth a "publishing cookbook" doc in v0.2 if we expect more contributors.
- `codemap rollup` not yet run on this dataset. Should produce the first weekly aggregate from these 6 turns.
- `last_verified_at` quirk (P1's round-number future timestamps) was caught only by manual inspection; v0.1.2 runtime regex accepts them as well-formed ISO strings. The strictness gap is "well-formed" vs "actually current."
