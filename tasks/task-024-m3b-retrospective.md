# Task 024: M3b Retrospective

**Status:** done (this file IS the deliverable)
**Phase:** M3 / Sprint 3b wrap-up
**Depends on:** task-020 (M3a retro), task-021 (`codemap init`), task-022 (tag/timestamp hygiene), task-023 (M3b prompt set)
**Drives:** task-011 (M3c — different codebase) becomes the next actionable; v0.3 task list

## Setup (continuation of M3a)

- Same target: voice2work via Codex Desktop with v0.2.0.
- Pre-flight: `npm publish` v0.2.0 → `npm i -g codemap-mcp@0.2.0 --prefer-online` → `codemap init --force` in voice2work to regenerate AGENTS.md from the v0.2.0 source-of-truth template.
- Starting graph state: 17 nodes / 11 edges (warm from M3a).
- Trial dates: 2026-05-01.

## Per-prompt scorecard

| | Slug | Q | Results | Emit | Cap | Links | Targeted | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M3b-1 | `auth-provider-rationale` | 1 | 10 | 1 | — | 4 | F2 (decision) | **✅ closed F2 + bonus derived_from (F3 partial)** |
| M3b-2 | `redis-rate-limit-plan` | 1 | 10 | 5 | — | 5 | F3 (replaces) | **✅ closed F3-replaces; full migration plan as graph** |
| M3b-3 | `auth-guard-helper-equivalence` | 2 | 22 | 4 | — | 9 | F3 (implements) | **⚠️ partial — agent chose `mirrors` over `implements` (defensible)** |
| M3b-4 | (isolation test) | — | — | — | — | — | AGENTS.md necessity | **deferred — user judgment call to wrap up** |

## What got closed

| F-finding | Status after M3b | Notes |
| --- | --- | --- |
| **F1** (Codex drops server.instructions) | ✅ resolved by `codemap init` (v0.2.0). Validated end-to-end: AGENTS.md regenerated from template, agent picked it up, behavior unchanged. |
| **F2** (0 decision-kind nodes) | ✅ closed in M3b-1 + M3b-2. Now 2 decisions: 1 retrospective (Supabase auth choice), 1 prospective (Redis migration plan). Confirms `decision` kind works for both temporal modes. |
| **F3** (`derived_from` / `replaces` / `implements` edge kinds unexercised) | ✅ derived_from + replaces both exercised. ⚠️ implements still 0 — see "Defensible miss" below. |
| **F4** (tag inflation, kind names as tags) | ✅ improved by v0.2.0 description tightening. M3b-2/3 emitted clean domain-slug tags only. |
| **F5** (round-number future timestamps) | Not specifically tested. Light-touch description tightening shipped; effect unclear without deeper inspection. |
| **F6** (retry/offline behavior) | Out of scope; M4 reliability work. |

## The defensible `implements` miss (M3b-3)

The prompt explicitly asked for guards that "implement the same logical 'authenticated user' contract." The agent had two paths:

| Path A (the one we expected) | Path B (the one the agent took) |
| --- | --- |
| Fabricate a `concept` kind node `auth/authenticated-actor-contract` | Skip the abstract concept node |
| Connect each guard to the concept via `implements` | Connect guards pairwise via `mirrors` |
| 4 implements edges from a fabricated abstraction | 5 mirrors edges + 3 derived_from edges |

V1_SPEC §6.2 wording is load-bearing: `implements` requires "an interface, contract, or pattern **defined by another**." Voice2work doesn't have an explicit auth-contract type; the agent **refused to fabricate the abstraction** and used `mirrors` (parallel implementations of the same idea) instead. That's V1_SPEC-correct.

Implication: `implements` will be a low-frequency edge kind for any TS/JS codebase without explicit interface culture. To exercise it, M3c should either pick a Java/C#/Go-style codebase, or accept that the kind is correctly rare for web stacks.

## What worked across M3b

| Behavior | Evidence |
| --- | --- |
| `decision` kind is reachable | 2 emissions across M3b-1 + M3b-2; 1 retrospective + 1 prospective; both correctly typed |
| Multi-query turns emerge | M3b-3 was the first 2-query turn; agent broadens search instead of committing to first results when prompt is broad |
| `derived_from` for layered relationships | Cleanly captured "this guard is built on that lower-level mechanism" — different from `mirrors` (sibling) and `depends_on` (catch-all) |
| Plan-as-graph (M3b-2) | Migration plan decomposed into decision + invariant + 2 gotchas + flow + 5 edges. An engineer can read the graph and have a complete picture of scope, risk, and test surface |
| Cap discipline holds at scale | 0 cap-busts across all 9 turns. Cap hit only when there was legitimately more to capture than the 5-budget |
| Dedup at scale | 27 nodes, 0 collisions ever |

## New M3b findings (additions to the retro)

| # | Finding | Severity | Action |
| --- | --- | --- | --- |
| F7 | Agent prefers concrete `mirrors` over abstract `implements` when no explicit contract node exists | Low | Either accept (V1_SPEC-correct), or address in M3c by picking a codebase with explicit interfaces, or in v0.3 by tightening `concept` kind description to encourage emission |
| F8 | Multi-query turns emerge naturally on broad prompts (M3b-3 had 2 queries / 22 results) | None — positive signal | Just noted |
| F9 | M3b-2 demonstrated planning-as-graph at production quality; the Redis migration plan is queryable + complete | None — design validation | Could become a documentation example in v0.3 README |

## v0.3 candidates (in priority order)

1. **task-011 — M3c codebase pick.** Already drafted as a todo. Now the natural next move. Recommendation: pick a TS-with-interfaces or Java/Go project to surface `implements`. Or pick something domain-different from voice2work (e.g. CLI tool, ML pipeline) to test cross-domain generalization.
2. **`concept` kind nudge** — minor description edit on `emit_node` to suggest creating concept nodes for shared contracts. Cheap; might unlock `implements` in TS-heavy codebases. Could be v0.2.1 or fold into v0.3.
3. **Optional: M3b-4 isolation test** — still useful data. Not blocking. Could be a 10-min experiment whenever convenient.
4. **Telemetry rollup verification** — `codemap rollup` not yet run on the now-9-turn dataset. Should produce a sensible weekly aggregate; if it doesn't, that's a v0.2.x bug.
5. **Documentation pass** — add a "Codemap in action" section to README with a screenshot/snippet of the voice2work graph as a worked example.

## M3 milestone status

After M3a + M3b: **M3 is substantively done.**

- Single-codebase validation: ✅ (voice2work, 27 nodes / 29 edges, 9 turns, 6 problem domains)
- Cross-codebase validation (M3c): ⏳ pending. Requires task-011 to pick a target.
- Behavioral validation: ✅ (agent honors lifecycle, cap, kind priority, dedup, edge-kind enum, knowledge-first emission)
- Protocol validation: ✅ (3 protocol-level findings shipped + landed: server.instructions, schema-shrink, codemap init)

The Codemap thesis holds. The remaining M3c work is generalization confirmation, not validation of the core idea.

## Final aggregate (after 9 turns / 4 versions of codemap / voice2work as the testbed)

| | Total |
| --- | --- |
| Versions shipped | 4 (0.1.0, 0.1.1, 0.1.2, 0.2.0) |
| PRs merged | 12 (PRs #6 through #17) |
| Turns of agent work | 9 (M3a × 6 + M3b × 3) |
| Nodes captured | 27 |
| Edges captured | 29 |
| Edge kinds exercised | 5 of 8 (depends_on / derived_from / mirrors / contradicts / replaces) |
| Node kinds exercised | 4 of 9 (invariant / gotcha / decision / flow) |
| Domains covered | 6 (auth web, auth mobile, voice→schedules, calendar OAuth+sync+retry, rate-limit defects, src structural map) + 1 plan domain (Redis migration) |
| Cap hits | 2 of 9 (both legit) |
| Collisions | 0 |
| Validator repairs | 0 |

## Notes

- The `mirrors` edge kind has emerged as the dominant equivalence relationship for non-Java codebases (7 of 29 total edges). Worth surfacing in V1_SPEC §6.2 examples.
- "Plan-as-graph" (M3b-2) is a genuinely new use case the V1_SPEC didn't explicitly anticipate. Worth a paragraph in V2 spec.
- After M3b-1 the agent has 2 pieces of cross-prompt knowledge it now reuses: "Supabase auth choice" + "in-memory rate limiter exists." Future investigations into either area will start from those nodes.
