# Task 018: MCP server.instructions + tool-description hardening (v0.1.1)

**Status:** in-progress (D1, D2, D3 approved — implementing)
**Phase:** M3 / Sprint 3a — direct response to M3a prompt-1 finding
**Estimate:** 1-2 hours
**Depends on:** task-017 (v0.1.0 published + global-installable)
**Blocks:** continued M3a trial run (prompts 2-6 pointless until this lands)

## The finding that motivates this task

M3a prompt 1 — "Walk me through how authentication works here" — was run against voice2work via Codex Desktop with a bare prompt (no M1-style preamble). Result:

| Tool | Expected | Actual |
| --- | --- | --- |
| `set_active_topic` | ✅ | ✅ once (`auth-walkthrough`) |
| `query_graph` | ✅ | ✅ once (0 results, expected cold-start) |
| `emit_node` | 3-5 | **0** |
| `link` | 3-8 | **0** |

Codex's verbatim reasoning:
> *"I checked codemap first; it did not have auth nodes indexed for this project, so I traced the repo directly."*

Codex explored 26 files, did 3 searches, ran 1 command, did 2 web searches — produced a great walkthrough — and **wrote nothing back to the graph**. It treated codemap as a read-only cache.

## Root cause

Two missing pieces:

1. **No `server.instructions` field on the MCP server.** The MCP protocol lets a server attach a lifecycle policy to the agent's system prompt at `initialize` time. We don't use it. The agent only sees per-tool descriptions in isolation — nothing tells it the cross-tool flow ("query, then explore, then write back").
2. **Tool descriptions describe mechanics, not lifecycle.** They tell the agent how each tool works individually, but don't push for the writeback that turns the graph from empty → useful.

## Decisions required

### D1 — `server.instructions` wording (the high-stakes call)

Three sliders to tune:

- **Length** — every word goes into every agent system prompt. Short = good for token budget, less coverage. Long = full guidance, more tokens.
- **Tone** — prescriptive ("MUST do X") vs suggestive ("consider doing X"). M1 spike used prescriptive checkpoints and that worked.
- **Examples** — bake them into instructions or leave them in tool descriptions.

**Proposed wording (recommend going with this verbatim):**

```
This server is a persistent knowledge graph of the open codebase
(.codemap/graph.json). Treat it as memory — query before exploring,
WRITE AFTER.

LIFECYCLE for any task that touches this codebase:

1. START: set_active_topic("<short-slug>") — resets per-turn emit budget.
2. BEFORE PLANNING: query_graph("<task description>"). If it returns
   nodes, read via get_node before re-deriving from source.
3. AFTER EXPLORING: emit_node for what you learned. Cap = 5/turn.
   PRIORITIZE: decision (non-obvious choices), invariant (must-hold
   properties), gotcha (silent failure modes). File / symbol / flow
   only if non-obvious.
4. CAPTURE RELATIONSHIPS: link(from, to, kind). Kinds: imports, calls,
   depends_on (catch-all), implements, replaces, contradicts,
   derived_from, mirrors.

NEVER skip step 3 because the graph "looks empty after step 2" — that's
how it stays empty. The graph is only worth something if every agent
that explores leaves something behind.

Emit at confidence >= 0.5 only. emit_node detects collisions and returns
candidates; re-call with merge_with: <id> or force_new: { reason: "..." }.
```

~180 words, prescriptive, lifecycle-anchored. Direct compression of the M1 instruction-doc's 3 checkpoints.

### D2 — Tool description tightening scope

Three options:

- A. Touch only `emit_node` (the one that didn't fire). Minimum-change.
- B. Touch `emit_node` + `link` + `set_active_topic` (all the writes / lifecycle hooks).
- C. Touch all 5.

**Recommendation: B.** `query_graph` and `get_node` were used correctly in prompt 1; tightening them risks regressing them. `emit_node`, `link`, `set_active_topic` form the writeback loop.

**Proposed new descriptions:**

- **`emit_node`** (current 372 chars → new 478 chars):
  > "Capture a finding from your exploration as a node in the graph. **Call this after answering any question that required reading code** — capture 1-5 high-value findings (prioritize decision/invariant/gotcha). Server-side collision detection: similar existing nodes return as candidates instead of writing — re-call with merge_with: <id> (same concept) or force_new: { reason: '<short>' } (genuinely different). Per-turn cap of 5; reset by calling set_active_topic. Auto-tags with the active topic. Skipping this is the #1 way the graph stays empty."

- **`link`** (current 367 chars → new 343 chars):
  > "Record a relationship between two nodes you've emitted. Call this after emit_node when you've identified that A imports/calls/depends_on/implements/replaces/contradicts/derived_from/mirrors B. Idempotent on (from, to, kind). Both endpoints must exist; aliases resolve to canonical ids. Use depends_on as the catch-all when no other kind fits — invented kinds are rejected."

- **`set_active_topic`** (current 246 chars → new 308 chars):
  > "Mark the start of a new task. Always call this first when you begin understanding or modifying the codebase. The slug ('auth-bugfix', 'payment-refactor') tags every emit_node you make this turn for future search, and resets the per-turn emit cap (5). Without calling this, your emissions are untagged and your per-turn budget is stale."

### D3 — README addition

Some MCP clients may not surface `server.instructions` to the agent (we'll find out empirically — Codex Desktop is the first test). For those, document the M1-style user preamble as a fallback in the README.

**Recommendation: short section, ~10 lines, points users at `/m1/instruction-doc.md` for the long form.**

## Deliverables

- `bin/codemap-mcp.ts`: pass `{ instructions: "..." }` as the second arg to `new McpServer(...)`. Bump version string to `0.1.1`.
- `src/instructions.ts` *(new)*: export the instructions string as a constant so tests can assert against it without duplicating the literal.
- `src/tools/emit_node.ts`, `src/tools/link.ts`, `src/tools/set_active_topic.ts`: replace descriptions per D2.
- `bin/codemap.ts`: bump CLI version string to `0.1.1`.
- `package.json`: bump to `0.1.1`.
- `README.md`: brief "Agent guidance" section per D3.
- `test/integration/mcp.test.ts`: assert the `initialize` response contains `instructions` and that the string mentions `set_active_topic`, `query_graph`, `emit_node`, `link` (smoke check on the lifecycle reaching clients).

## Steps

1. Get D1, D2, D3 user-approved (this task file is the surface for that).
2. Branch `task-018-server-instructions`.
3. Add `src/instructions.ts` with the approved wording.
4. Wire into `bin/codemap-mcp.ts`.
5. Replace the three tool descriptions per D2.
6. Bump versions in `package.json` and `bin/codemap.ts`.
7. Update README per D3.
8. Add test assertion.
9. Run `bun run typecheck && bun test && ./scripts/smoke-test.sh && npm publish --dry-run`.
10. Commit, push, open PR.
11. After merge: republish `npm publish --access public` (no `--provenance`).
12. Reinstall global: `npm i -g codemap-mcp@0.1.1`.
13. Restart Codex Desktop.
14. Delete `voice2work/.codemap/` to force a clean re-trial of prompt 1.
15. Re-run prompt 1, observe whether emit_node now fires.

## Exit criteria

- [ ] D1, D2, D3 approved by user
- [ ] `initialize` response from `codemap-mcp` contains the lifecycle instructions
- [ ] Tool descriptions updated for emit_node, link, set_active_topic
- [ ] All tests pass; smoke test passes; publish-dryrun gate passes
- [ ] v0.1.1 published to npm
- [ ] M3a prompt 1 re-run produces ≥3 nodes and ≥2 edges in `voice2work/.codemap/graph.json`
- [ ] If prompt 1 still produces 0 nodes after this patch: open task-019 (Codex Desktop ignores server.instructions; user-side preamble is mandatory)

## What's intentionally NOT here

- Adding a "record_findings" batch tool to lower per-emission overhead. v0.2 if descriptions+instructions don't fix it alone.
- Telemetry-side detection of "explored without emitting" (would need new metric). v0.2.
- Auto-injecting the preamble at the user's chat layer. Out of scope; per-client behavior.

## Notes

- Re-trialing prompt 1 against an empty `.codemap/` is the primary validation signal. If `emit_node` fires this time, the architectural fix worked. If not, the next step is figuring out whether Codex Desktop suppresses `server.instructions` (in which case we need the README preamble path) or whether the agent still needs a stronger nudge.
- This patch costs ~180 words of system-prompt budget per session for any MCP client that surfaces `server.instructions`. Trade-off: acceptable, since the graph is the entire value proposition.
