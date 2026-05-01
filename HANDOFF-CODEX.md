# Handoff to Codex — Phase 4 starts here

> **Read this first.** It's the single source of truth for "where the project is and what to do next." Everything else (specs, retros, tasks) is reachable from here.

## What Codemap is (in 3 lines)

A persistent knowledge graph of a codebase, built incrementally by AI agents during normal work, exposed via MCP, stored as a single JSON file in the repo (`.codemap/graph.json`). Diffable, reviewable, no DB. The point: convert ad-hoc agent exploration into team-readable memory so the next agent doesn't re-derive what the previous one already learned.

Three docs are the real source of truth:
- [`V1_SPEC.md`](V1_SPEC.md) — what we're building
- [`TECH_SPEC.md`](TECH_SPEC.md) — how it works
- [`ROADMAP.md`](ROADMAP.md) — milestones + Phase 4 candidate list

## Where we are right now

**M3 is closed.** PR #18 merged the wrap-up. Status:

| | |
| --- | --- |
| Published | `codemap-mcp@0.2.0` on npm (https://www.npmjs.com/package/codemap-mcp) |
| Releases shipped | 0.1.0 → 0.1.1 → 0.1.2 → 0.2.0 (4 versions, all on registry) |
| MCP tools | 5 working: `set_active_topic`, `query_graph`, `get_node`, `emit_node`, `link` |
| CLI subcommands | `init`, `show`, `correct`, `deprecate`, `validate`, `rollup` |
| M3 trial result | 9 turns × Codex Desktop × voice2work → 27 nodes / 29 edges across 6 problem domains, 5 of 8 edge kinds + 4 of 9 node kinds exercised. **Codemap thesis validated.** |
| Test count | 254 / 254 pass |
| CI | green on every PR; `publish-dryrun` job is the strict gate |

**Read these two retros before doing anything** — they have the M3 ground truth + open findings:
- [`tasks/task-020-m3a-retrospective.md`](tasks/task-020-m3a-retrospective.md) — the M3a retro (cold-start trial)
- [`tasks/task-024-m3b-retrospective.md`](tasks/task-024-m3b-retrospective.md) — the M3b retro (warm-graph trial + decision-kind elicitation)

## What's next: Phase 4

Per ROADMAP §"Phase 4 — V2 candidates (post-M3)", the playbook is **pick ONE v2 feature based on M3's biggest pain.** Five ranked candidates:

| Rank | Candidate | Estimate | When to pick |
| --- | --- | --- | --- |
| 1 | **VS Code panel** (visible graph for humans) | 3-4 weeks | If the graph is good but invisible — humans never look at it |
| 2 | **Embeddings-based retrieval** | 1 week | If `query_graph` keeps missing relevant nodes |
| 3 | **Auto-approve / batched emit** | 3-5 days | If approval prompts hurt UX |
| 4 | **Branch-safe operation** (proper merge) | 2 weeks | When 2+ active devs share a graph |
| 5 | **Behavioral graph extraction** (state machines, enums) | 4+ weeks | The "cool demo" — depends on 1-4 working first |

### What M3 actually revealed about pain

- **#1 (VS Code panel) — high signal.** Across the M3 trial, the only way the user saw the graph was through me running `jq` queries against `voice2work/.codemap/graph.json`. There's no humans-look-at-the-graph surface today. The graph is good (27 nodes, 5 edge kinds, semantically rich) but invisible.
- **#2 (Embeddings) — low signal.** `query_graph` consistently returned 10 results (the default cap) when there were ≥10 candidates. Lexical retrieval is doing fine on a 27-node graph. May matter at 100+ nodes, but no current pain.
- **#3 (Auto-approve) — no signal.** Agent emits autonomously inside Codex; no approval prompts observed.
- **#4 (Branch-safe) — N/A.** Single-dev project so far.
- **#5 (Behavioral extraction) — premature.**

**The honest read: candidate #1 (VS Code panel) is the most valuable next move.** Candidate #3 might piggyback as a small addition. Candidate #2 is cheap but hasn't earned its slot from observed pain.

### The Phase 4 decision is the user's call

Don't pick unilaterally. **First action**: read the two retros above, surface a recommendation with reasoning, ask the user which v2 candidate to start. Then draft `tasks/task-025-<slug>.md` with the design decisions and execute.

## How to work in this repo (the conventions)

These were learned during M3, not in any spec — propagate them.

### Cadence

- **Option B**: one task per PR. Surface decisions in the task file before implementing. Get user signoff on decisions, then build.
- Each PR includes: code/docs, version bump if applicable, tests, smoke test, publish-dry-run check, task file in `tasks/` updated.
- Greptile bot reviews PRs — address P1 findings before merge.

### Commits

- **NEVER** include `Co-Authored-By: Claude` (or any Claude/Anthropic trailer) — user-level rule. Same applies to **OpenAI/Codex/GPT trailers**: don't add them either. Pure-content commits, no agent attribution.
- **NEVER** add `🤖 Generated with [Claude Code](...)` or `🤖 Generated with [Codex](...)` footers to PR bodies, issue bodies, or comments. Same rule, broader scope.
- Concise commit messages, lead with the why. HEREDOC for multi-line.
- See `~/.claude/CLAUDE.md` for the full rule (it's strict and the user has called it out twice).

### Releasing

The publish flow has 5 friction points the user hit. Capture this in any release task:

1. `npm publish --provenance` only works in CI (local fails with `provider: null`). Use `npm publish --access public` from local.
2. npm requires 2FA for publish, OR a token marked "bypass 2FA when publishing." User has the latter saved in `~/.npmrc` — works automatically.
3. After publish, `npm i -g codemap-mcp@<version>` may fail with `ETARGET` because npm CLI's metadata cache is stale. Fix: `npm i -g codemap-mcp@<version> --prefer-online`.
4. Bin paths in `package.json` must NOT start with `./` — npm strips them at publish (silently dropping the bin field). Always `dist/cli/x.js`, never `./dist/cli/x.js`. CI's `publish-dryrun` job catches this via grep on `^npm warn publish` lines.
5. Publishing instructions: tagged with `latest` and `--access public` (required for unscoped names on every publish).

### Codemap-on-codemap (dogfood)

This repo has its own `AGENTS.md` (auto-generated by `codemap init`). When working in codemap source:
- The codemap MCP server is wired in `~/.codex/config.toml` under `[mcp_servers.codemap]`.
- It launches with cwd = the project you have open. Open codemap → it reads/writes `codemap/.codemap/graph.json`.
- Use the lifecycle in `AGENTS.md` for any codemap-source task: `set_active_topic` → `query_graph` → emit findings → link relationships.

## Critical files map

```
codemap/
├── V1_SPEC.md                     spec source of truth
├── TECH_SPEC.md                   technical decisions
├── ROADMAP.md                     milestones + Phase 4 v2 candidates
├── README.md                      install + 5-tool overview + agent guidance
├── AGENTS.md                      codemap dogfood (auto-generated by `codemap init`)
├── HANDOFF-CODEX.md               this file
├── tasks/
│   ├── README.md                  task index — STATUS COLUMN IS THE TRUTH
│   ├── task-NNN-slug.md           one file per task
│   ├── task-020-m3a-retrospective.md   ← read for M3 ground truth
│   └── task-024-m3b-retrospective.md   ← read for M3 ground truth
├── src/
│   ├── instructions.ts            SERVER_INSTRUCTIONS + agentsMdContent (single source of truth for lifecycle policy — used by both MCP server and `codemap init`)
│   ├── tools/                     5 MCP tool implementations
│   │   ├── _active_topic.ts       module-scoped per-turn state + cap counter
│   │   ├── set_active_topic.ts
│   │   ├── query_graph.ts
│   │   ├── get_node.ts
│   │   ├── emit_node.ts           most complex — collision check, cap, merge_with, force_new
│   │   └── link.ts
│   ├── cli/                       6 CLI subcommand implementations
│   │   ├── _types.ts              CommandResult / GlobalOptions
│   │   ├── init.ts                v0.2.0 — generates AGENTS.md from SERVER_INSTRUCTIONS
│   │   ├── show.ts
│   │   ├── correct.ts
│   │   ├── deprecate.ts
│   │   ├── validate.ts
│   │   └── rollup.ts
│   ├── schema.ts                  zod schemas for graph file (Node, Edge, GraphFile, etc.)
│   ├── graph.ts                   GraphStore class (load/save/query/upsert/etc.) with proper-lockfile
│   ├── validator.ts               validate() + applyRepairs() for graph integrity
│   ├── collision.ts               weighted similarity for emit_node dedup
│   ├── metrics.ts                 telemetry per-turn + weekly rollup
│   └── index.ts                   registerTools() — wires the 5 MCP tools
├── bin/
│   ├── codemap.ts                 CLI entry (commander)
│   └── codemap-mcp.ts             MCP stdio server entry (passes SERVER_INSTRUCTIONS to McpServer constructor)
├── test/
│   ├── unit/                      schema, graph, validator, collision, cli, metrics
│   └── integration/mcp.test.ts    drives the MCP server via InMemoryTransport — pin tests for v0.1.1+0.1.2+0.2.0 contracts live here
├── scripts/smoke-test.sh          end-to-end pack + install + bin + MCP handshake check (CI runs this on every PR)
├── .github/workflows/ci.yml       3 jobs: test-bun / test-node / publish-dryrun (the strict gate that catches publish warns)
└── package.json                   bin paths must NOT start with ./
```

## Known open issues (not blocking, but document them)

| # | Issue | Notes |
| --- | --- | --- |
| F5 | Agent invents round-number future timestamps for `last_verified_at` | M3a finding. v0.2.0 description tightening shipped; effect not specifically tested. Probably fine; verify in next trial. |
| F7 | `implements` edge kind unexercised | Agent refuses to fabricate `concept` nodes (V1_SPEC-correct). Will likely surface only in TS-with-interfaces / Java / Go codebases. |
| — | M3b-4 isolation test deferred | Optional 10-min experiment: does `codemap init`-generated AGENTS.md remain necessary, or does v0.2.0's improved Codex behavior alone suffice? Useful data point, not blocking. |
| — | `codemap rollup` not yet run on real data | Should produce a sensible weekly aggregate from the voice2work 9-turn dataset. If it doesn't, that's a v0.2.x bug. |
| — | M3c (cross-codebase) skipped | User chose to close M3 without it. task-011 is still drafted if anyone wants to revisit later. |

## How to ship a release (recipe)

1. Branch `<task-slug>` off main.
2. Code + tests + task file update.
3. `bun run typecheck && bun test && ./scripts/smoke-test.sh` — must all be clean locally.
4. `npm publish --dry-run --provenance --access public` — must show **zero** `npm warn publish` lines.
5. Bump version in 3 places: `package.json`, `bin/codemap.ts`, `bin/codemap-mcp.ts` (the McpServer constructor call).
6. Commit with concise message, no agent attribution.
7. Push, open PR, address greptile P1.
8. After CI green + user merges: `git checkout main && git pull && npm publish --access public` from local. (No `--provenance` from local — only works in CI.)
9. Verify: `npm view codemap-mcp version` shows new version. `npm i -g codemap-mcp@<v> --prefer-online` to upgrade local install.

## Your first three actions

1. **Read the two retros** ([task-020](tasks/task-020-m3a-retrospective.md), [task-024](tasks/task-024-m3b-retrospective.md)) — 5 minutes, gives you the same M3 context I have.
2. **Surface a Phase 4 recommendation to the user** — concise, with reasoning. Default recommendation: candidate #1 (VS Code panel) based on M3 pain signals.
3. **Wait for the user to pick.** Then draft `tasks/task-025-<slug>.md` with the design decisions surfaced for review (don't implement before signoff). Same option-B cadence as M3.

If the user has already picked the candidate by the time you read this, skip step 2 and go straight to drafting task-025.

## Tone + working style notes (small but real)

- The user prefers concise, direct messages. No filler. No emojis unless they use them first.
- Surface decisions as numbered options with a recommendation. Don't make ambiguous choices unilaterally on architectural calls.
- Use the codemap MCP server while working in this repo. Set a topic, query first, emit findings, link relationships. The repo's own `AGENTS.md` has the lifecycle.
- When you commit/PR/release: triple-check no agent attribution slips in. The user has called this out twice — don't be the third.
- The user is a single-dev personal project owner with limited time. Prefer cheap experiments over expensive ones; prefer shipping over polishing.

Good luck. The hard parts (M2 server, M3 validation) are done. Phase 4 is "what would I show off this graph for?" — go answer that.
