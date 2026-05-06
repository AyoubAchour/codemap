# Codemap — Development Roadmap

> Companion to `V1_SPEC.md` and `TECH_SPEC.md`. This document is the time-and-sequence plan: what gets built when, and what tells us we can move on.

## How to read this

Each milestone has:

- **Deliverables** — concrete artifacts produced.
- **Exit criteria** — what must be true to advance to the next milestone. Gates are hard; do not advance with failing criteria.
- **Risks** — what could derail it, with mitigations.

Time estimates assume **one developer working ~half-time (≈20 hr/week)**. Scale up or down accordingly.

## Phase 0 — Setup (3–5 days)

Goal: working dev environment + fixture repo to test against.

### Deliverables

- GitHub repo created with CI (lint + test on push).
- Project skeleton scaffolded per `TECH_SPEC.md` §2.
- One real codebase chosen as the M1 / M3 target. Should be a project you know well (yours or a familiar one), 5–50k LOC, with mixed concerns (auth, db, integrations, payments).
- Bun installed; `bun test` runs an empty placeholder test.
- Placeholder `package.json` published as `0.0.0` so `npx` config works during M1.

### Exit criteria

- `bun run typecheck` and `bun test` pass on a hello-world tool registration.
- The chosen target codebase is cloned and ready to point Claude Code at.

### Risks

- Bun edge cases on Windows. Mitigation: fall back to Node 22 for v1 if blocking.

## Phase 1 — M1: Instruction-document spike (1 week)

Goal: validate the agent loop **conceptually** before writing the real MCP server.

The biggest risk in this whole project (per the second review) is *"agents will skip writeback because cost is immediate, benefit delayed."* M1 is the direct probe of that.

### Approach

- **No MCP server yet.** Use a fake `graph.json` Claude reads/edits via its built-in file tools.
- Give Claude the §8 instruction document from `V1_SPEC.md` verbatim, with a note that "MCP tools" are simulated by direct JSON edits.
- Run **4–6 sequential tasks within ONE subsystem** of the target codebase (e.g. just `auth/`, or just `payment/`). Don't span the whole repo on the first trial.
- Record every turn: did Claude query? did it emit? what kinds (decision/invariant/gotcha vs file)? did it skip checkpoints?

### Deliverables

- 4–6 transcripts of Claude sessions on real tasks.
- A revised instruction document if the v1 wording fails in practice.
- A short retrospective doc with: emission rate, skip rate, kind distribution, qualitative observations.

### Exit criteria (all four must hold)

1. By task 4–6, Claude meaningfully **re-uses** nodes from earlier tasks instead of re-exploring.
2. Claude maintains discipline at all 3 checkpoints **without explicit reminders**.
3. **≥30%** of emitted nodes are `decision` / `invariant` / `gotcha` kinds — not just file summaries.
4. Claude does **not** skip the writeback loop. If by task 2 it's omitting Checkpoint 2, the instruction document needs redesign.

### Decision gate

- All 4 hold → proceed to M2.
- 1–2 fail → iterate on the instruction document; re-run M1 with a different subsystem. **Do not start M2.**
- 3+ fail → pause. The product hypothesis is in trouble; consider whether enforcement-via-prompts is fundamentally insufficient and whether Codemap needs different framing.

### Risks

- Claude treats the fake `graph.json` differently than it would treat real MCP tools (less ceremony, more freelancing). Mitigation: structure the simulation as discrete read-then-write steps that mimic real tool calls.
- Subsystem chosen is too small (no compounding visible) or too large (agent can't form a clean mental map). Mitigation: pick something with 3–8 logical components and at least 3 task ideas.

## Phase 2 — M2: MVP MCP server (2–3 weeks)

Goal: replace the M1 simulation with a real MCP server, validated end-to-end against Claude Code.

### Sprint 2.1 — Core data layer (week 1)

**Deliverables**

- `src/schema.ts` — zod schemas + types per `TECH_SPEC.md` §3.1.
- `src/graph.ts` — `GraphStore` with load / save / validate, atomic writes, alias resolution.
- Unit tests on graph store CRUD and validator (≥80% coverage on these modules).
- 10–15 fixture graphs covering edge cases (empty, small, aliases, collisions, deprecated, malformed, dangling edges).

**Exit criteria**

- Validator catches: malformed JSON, dangling edges, alias collisions, schema-version mismatch.
- Atomic save survives `kill -9` mid-write (fixture-tested via crash-injection helper).

### Sprint 2.2 — Tools and collision detection (week 2)

**Deliverables**

- `src/collision.ts` — similarity scoring per `TECH_SPEC.md` §4.
- `src/tools/*.ts` — all 5 MCP tools.
- `src/index.ts` — server entry registering all tools.
- `bin/codemap-mcp.ts` — stdio transport entry.
- Per-turn cap enforcement (in-memory counter scoped to `set_active_topic`).
- Integration tests: spawn server, drive via JSON-RPC, assert responses on every tool path.

**Exit criteria**

- All 5 tools respond correctly on the fixture graphs.
- Collision detection catches the planted-collision pairs in fixtures (no false negatives on the test set).
- Per-turn cap kicks in after 5 emissions.
- `bun build --compile` produces a working single binary.

### Sprint 2.3 — CLI + polish (week 3)

**Deliverables**

- `bin/codemap.ts` — CLI with `show`, `correct`, `deprecate`, `validate`, `rollup`.
- Telemetry writes (`metrics.json`).
- README with install + Claude Code config snippet.
- npm package published as `0.1.0`.
- Manual smoke test: install via `npx` on a clean machine, configure Claude Code, run a real task end-to-end.

**Exit criteria**

- `npx -y @your-org/codemap-mcp` works from a clean install.
- One real Claude Code task on the target codebase succeeds: query → discover → emit → second task uses prior node successfully.

### Risks

- **Approval friction.** Claude Code may prompt user to approve every MCP tool call. Mitigation: investigate per-tool auto-approve config in `~/.claude/settings.json`; if unsolvable, batched-emit becomes a v1 must-have (one tool call emits multiple nodes).
- **Collision threshold (0.65) wrong in practice.** Mitigation: env-var tunable; iterate during M3.
- **Bun packaging quirks** on certain platforms. Mitigation: GitHub releases ship native binaries via cross-compilation; npm fallback for the rest.

## Phase 3 — M3: Real-codebase trial (2 weeks)

Goal: dogfood Codemap on real work for 2 weeks. Measure whether the loop holds and whether the graph improves task outcomes.

### Approach

The 2-week trial is split into **three phases**, each testing a distinct generalization claim. Total ~10–13 sessions across 2 weeks.


| Phase  | Days  | Target                                                                              | What it tests                                                                                                                              | Sessions |
| ------ | ----- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| **3a** | 1–4   | voice2work `auth` (same as M1)                                                      | Cross-time: does the existing graph stay useful as the agent does new auth work? Does it get noisy? Does staleness become real?            | 3–4      |
| **3b** | 5–10  | voice2work *different subsystem* (Voice phone or Payment)                           | Cross-subsystem: does discipline hold on less-rehearsed territory? Does the agent appropriately *not* reuse auth nodes for unrelated work? | 4–5      |
| **3c** | 11–14 | A second codebase the user knows reasonably well (different repo, ideally TS-stack) | Cross-codebase: do emission patterns and quality match? Does single-graph-per-repo cause friction?                                         | 3–4      |


For all phases:

- Do real work — bug fixes, features, refactors. No artificial test tasks.
- Write down 3–5 concrete predictions before each task ("Claude will / won't re-discover X"). Track hit rate.
- Phase-end retros (after 3a, 3b, 3c) plus the final cumulative retro.

**Don't pick an unfamiliar OSS codebase for 3c.** That tests onboarding — a separate problem, deferred to v2 (Phase 4 candidate). 3c needs the user to be able to judge node quality, which requires familiarity.

- Weekly retros after week 1 and week 2.

### Deliverables

- 2 weeks of personal use logged.
- A populated `.codemap/graph.json` with ≥40 nodes and ≥25% knowledge-kind ratio.
- A populated `.codemap/metrics.json` with ≥30 turns logged.
- Two short retrospective notes (one per week).
- An honest **GO / NO-GO** decision for v2.

### Exit criteria (telemetry + subjective)

- Stale-recheck rate <10% of `query_graph` calls.
- Knowledge-kind ratio sustained ≥25%.
- No persistent cap-hits across multiple consecutive turns (rare hits OK; persistent = instructions need tuning).
- Subjective: "I trust Claude more on follow-up tasks; I notice less re-explanation."

### Risks

- Graph becomes noisy and stops being useful. Mitigation: lower the cap; tighten the instruction doc.
- Agent stops calling tools after a few sessions (drift). Mitigation: this is the M1 risk re-emerging at scale; fix the instruction doc, not the server.
- Measurements drift into pure subjectivity. Mitigation: the prediction-tracking practice keeps it honest.

## Phase 4 — Behavior consistency (post-M3 reset)

M3 validated the core thesis, but the next constraint is graph quality, not visuals. The user explicitly parked visual work until the agent behavior is consistent and the graph remains codebase-scoped.

| Rank | Candidate                                           | Estimate | When to pick it                                           |
| ---- | --------------------------------------------------- | -------- | --------------------------------------------------------- |
| 1    | Codebase-only writeback guardrails                  | 1 week   | If agents risk polluting the graph with non-repo facts    |
| 2    | Instruction lifecycle hardening                     | 3-5 days | If agents over-call tools or skip writeback on repo tasks |
| 3    | Local source-index retrieval                        | 1 week   | If cold-start source discovery is slower than graph reuse  |
| 4    | Branch-safe operation (proper merge)                | 2 weeks  | When 2+ active devs share a graph and conflicts are real  |
| 5    | Behavioral graph extraction (state machines, enums) | 4+ weeks | Only after the basic memory loop is consistently trusted  |

Task 030 builds on the local source-index slice with `query_context`, a fused
pre-planning read that returns graph matches, source status/search, staleness,
deduplicated related nodes, warnings, and next steps in one response.

Task 031 tightens the same behavior-first lane with a graph health doctor and
dependency-aware source context. The doctor makes stale or duplicated graph
memory visible without writing repairs; dependency context adds nearby
imports/importers to source hits so agents inspect related files before
emitting durable findings.

Task 032 follows the 0.5.0 release by dogfooding those health signals: update
release-truth docs, make `codemap doctor` readable by default, clean stale local
graph memory, and verify the published package in another real checkout.

Task 033 shipped the post-0.5.0 polish as `codemap-mcp@0.5.1`: compact
doctor/CLI flush improvements plus the public README cleanup before the next
behavior slice starts.

The next competitive-hardening sequence borrows the useful parts of
DeepContext, GitNexus, codebase-memory, Serena, Memento/Engram, and workflow
hook systems without abandoning Codemap's core thesis as curated repo memory:

- Task 034: agent compliance and onboarding.
- Task 035: `query_context` v2 with better local retrieval and match reasons.
- Task 036: TS/JS symbol and impact context.
- Task 037: memory quality and ranking.
- Task 038: workflow auto-capture suggestions that never write graph nodes
  automatically.

This order is intentional: improve agent behavior first, then retrieval, then
impact context, then trust/ranking, then end-of-turn capture assistance.

Task 039 shipped the `0.5.2` patch release for task 034, so installed MCP users
receive the generated-guidance freshness check and stricter Agent Contract
before task 035 starts.

Task 035 improves local-first retrieval by adding graph/source match reasons,
compact score breakdowns, deterministic source-result diversity, and clearer
query-time provenance warnings. Embeddings remain a future optional layer only
after local retrieval misses are observed in dogfood.

Task 036 adds bounded TS/JS impact context without changing Codemap's local-first
posture: source hits can include indexed definitions, exact direct imports,
exact direct importers, exported symbols, likely affected files, and approximate
lexical references. This is planning context for edits, not proof of every
runtime effect.

Task 037 adds query-time memory quality ranking without changing the persisted
graph schema. Graph results now include `ranking_score` plus compact quality
metadata derived from lexical match, confidence, source-anchor freshness,
verification age, node kind, and status. `query_context.graph.memory_quality`
separates high-trust node ids from stale or low-trust ids that should be
inspected before use.

Task 038 adds read-only workflow auto-capture suggestions. `suggest_writeback`
and `codemap suggest-writeback` turn active topic, optional inspected/modified
files, optional work summary, git changed files, and graph staleness signals
into possible `decision`, `invariant`, `gotcha`, or `link` prompts. Suggestions
never create graph memory automatically.

Task 040 shipped the `0.6.0` minor release. It packages the behavior-facing
work from tasks 035-038 for installed users: local-first retrieval
explanations, source-result diversity, bounded TS/JS impact context, query-time
memory quality ranking, and read-only workflow writeback suggestions.

## Cumulative timeline (single dev, half-time)


| Phase                    | Calendar weeks | Cumulative  |
| ------------------------ | -------------- | ----------- |
| Phase 0 — Setup          | 1              | Week 1      |
| Phase 1 — M1 spike       | 1              | Week 2      |
| Phase 2 — M2 server      | 3              | Week 5      |
| Phase 3 — M3 trial       | 2              | Week 7      |
| **V1 ships**             |                | **~Week 7** |
| Phase 4 — Behavior consistency | 1–3      | Week 8–10   |


If full-time: roughly halve. If quarter-time: roughly double.

## Out of v1 (parking lot)

Captured here so they're not forgotten and not accidentally added:

- Web UI / editor extension / visual graph viewer.
- Live file-watcher updates as code changes (without agent involvement).
- Branch / PR merge UX.
- Embeddings-based retrieval and hosted/vector providers.
- HTTP/SSE MCP transport.
- Multi-language behavioral extraction (state machines, enum invariants, data-flow tracing).
- Multi-agent verification beyond Claude Code.
- Hosted / cloud version.

These resurface only after the codebase-memory loop is consistently trusted.

## Single most important rule

**Don't skip M1.**

It's tempting to say "the spike is just for prompt iteration; the real work is the server." That framing is wrong. The spike is the cheapest test of whether the entire product hypothesis works. If Claude won't keep using the tools when prompted — and the second review's biggest-risk call says it might not — there is no point building the server.

If M1 fails its exit criteria, the answer is *not* "well, build the server anyway and hope." The answer is iterate on the instruction document until M1 passes, or accept that this product needs different framing.
