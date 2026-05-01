# Task 023: M3b prompt set + trial v5 isolation (post-v0.2.0)

**Status:** todo (pending v0.2.0 publish)
**Phase:** M3 / Sprint 3b
**Estimate:** 30-45 min of agent time + 30 min analysis
**Depends on:** task-021 (`codemap init`), task-022 (description tightening), v0.2.0 published
**Targets:** M3a findings F2, F3, F4, F5 + the unanswered question about AGENTS.md necessity

## Goal

Run a focused M3b prompt set against the now-populated voice2work graph (17 nodes / 11 edges) to:

1. **Confirm v0.2.0 fixes** for M3a findings F4 (tag inflation) + F5 (timestamp quirks) hold under real agent use.
2. **Exercise the unexercised edge kinds** (F3): `derived_from`, `replaces`, `implements`. Currently 0/3 used.
3. **Exercise the `decision` node kind** (F2): currently 0/9 emitted. M3a's prompts asked for traces / diagnoses / recommendations — none asked for retrospective design choices.
4. **Resolve the AGENTS.md question** (trial v5): does v0.2.0's improved Codex behavior require AGENTS.md, or is `codemap init` a recommendation rather than a requirement?

## Pre-flight

After PR #17 merges:

```sh
git checkout main && git pull
npm publish --access public
npm i -g codemap-mcp@0.2.0 --prefer-online    # --prefer-online bypasses npm metadata cache
codemap -V                                     # should print 0.2.0
cd /path/to/voice2work
codemap init --force                           # regenerate AGENTS.md from v0.2.0's lifecycle string
# (do NOT delete .codemap/ — we want the existing 17 nodes / 11 edges as the warm starting point for M3b)
# Quit + relaunch Codex Desktop fully
```

## Prompts (run in order, fresh Codex turn for each)

### M3b-1 — `decision` elicitor (targets F2)

> Why does this app use Supabase auth instead of, say, Auth.js or Clerk? Look at the existing patterns and the auth-related codemap nodes, then capture the inferred trade-offs as a decision-kind node.

**Expected**: 1+ `decision` kind node (e.g. `auth/why-supabase-not-clerk`). Possibly a `derived_from` edge linking the decision to existing invariant nodes (`auth/web-signin-supabase-ssr`, `auth/server-cookie-client-and-get-user`, etc.).

**Success criteria**: ≥1 `decision` kind node. Bonus if `derived_from` edge appears.

### M3b-2 — refactor planner (targets `replaces` + F3)

> I want to migrate the in-memory rate limiter (`external-api-rate-limits/in-memory-fixed-window`) to Redis. Plan the change: what files would I touch, what gets replaced, and what existing patterns should I preserve. Don't fix anything; capture the plan as nodes/edges.

**Expected**: 1+ new node for the proposed Redis-backed implementation. **`replaces` edge** from new node to `in-memory-fixed-window`. Possibly `decision` kind for the migration choice.

**Success criteria**: ≥1 `replaces` edge. ≥1 new node about the proposed implementation.

### M3b-3 — `implements` test (targets F3)

> List every auth-guard helper this app uses (web cookie path, mobile bearer path, server components, route handlers). Tell me which ones implement the same logical "authenticated user" contract, and capture those equivalences as edges.

**Expected**: Multiple `implements` edges connecting different guard nodes to a shared "authenticated user" concept node. Possibly a new `concept` kind node ("authenticated-actor-contract") that the guards implement.

**Success criteria**: ≥2 `implements` edges. Possibly 1 new `concept` kind node.

### M3b-4 — Trial v5 (isolation, AGENTS.md presence test)

This is a **two-part comparison**, run in this exact order:

**Part A — control**: just confirm AGENTS.md is in place, then re-run the original M3a-P1 cold-start prompt **but on a deleted `.codemap/`**:
```sh
ls /path/to/voice2work/AGENTS.md   # confirm exists
rm -rf /path/to/voice2work/.codemap
```
> I'm new to this codebase. Walk me through how authentication works here — from a user clicking 'sign in' to their session being available in API routes. Be specific about file paths.

Snapshot the resulting `metrics.json` first per_turn entry — call this `A`.

**Part B — isolation test**: now delete AGENTS.md AND .codemap, restart Codex Desktop, re-run the same prompt:
```sh
rm /path/to/voice2work/AGENTS.md
rm -rf /path/to/voice2work/.codemap
```
> (same prompt verbatim)

Snapshot the resulting `metrics.json` first per_turn entry — call this `B`.

**Verdict**:
- If `B.nodes_emitted >= 3` → AGENTS.md is helpful but not strictly required for v0.2.0. `codemap init` becomes a recommendation in the README, not a hard requirement.
- If `B.nodes_emitted == 0` → AGENTS.md is mandatory for Codex Desktop. `codemap init` becomes a required step in the install flow (already documented as such in the v0.2.0 README, so this just confirms it).

After Part B, **restore AGENTS.md** with `codemap init` so subsequent work continues to behave well.

## Reporting

For each prompt, capture (claude reads from disk):
- `metrics.json` first per_turn entry
- new nodes added (by kind)
- new edges added (by kind)
- whether the success criteria for that prompt were met

Then write a short M3b retrospective into `tasks/task-024-m3b-retro.md` (to be created at the end). That retro determines what (if anything) goes into v0.2.1 / v0.3.0 and whether M3 is GO for declaring done.

## What's intentionally NOT here

- New target codebase (M3c per ROADMAP) — separate task. Voice2work has been the singular target through M3a + M3b.
- Stress tests (concurrent agents, large graphs) — M4 reliability work.
- VS Code panel / embeddings — V2.
