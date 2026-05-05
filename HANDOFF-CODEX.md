# Handoff to Codex — behavior-first pivot

> **Read this first.** It's the single source of truth for "where the project is and what to do next." Everything else (specs, retros, tasks) is reachable from here.

## What Codemap is (in 3 lines)

A persistent knowledge graph of a codebase, built incrementally by AI agents during normal work, exposed via MCP, stored as a single JSON file in the repo (`.codemap/graph.json`). Diffable, reviewable, no DB. The point: convert ad-hoc agent exploration into team-readable memory so the next agent doesn't re-derive what the previous one already learned.

Three docs are the real source of truth:
- [`V1_SPEC.md`](V1_SPEC.md) — what we're building
- [`TECH_SPEC.md`](TECH_SPEC.md) — how it works
- [`ROADMAP.md`](ROADMAP.md) — milestones + parked v2 candidates

## Where we are right now

**M3 is closed, and Phase 4 has been reset.** PR #18 merged the wrap-up; a later visual-extension spike was removed so the project can focus on behavior consistency before any human-facing graph surface. Status:

| | |
| --- | --- |
| Published | `codemap-mcp@0.5.1` on npm (https://www.npmjs.com/package/codemap-mcp); GitHub release `v0.5.1` is live |
| Pending release | `0.5.2` patch prep for the merged agent-guidance freshness check |
| Releases shipped | 0.1.0 → 0.1.1 → 0.1.2 → 0.2.0 → 0.2.1 → 0.2.2 → 0.3.0 → 0.4.0 → 0.5.0 → 0.5.1 |
| MCP tools | Graph memory: `set_active_topic`, `query_context`, `query_graph`, `get_node`, `graph_health`, `emit_node`, `link`; source discovery: `index_codebase`, `search_source`, `get_index_status`, `clear_index` |
| CLI subcommands | `init`, `show`, `correct`, `deprecate`, `validate`, `doctor`, `rollup`, `scan`, `context`, `search-source`, `index-status`, `clear-index` |
| M3 trial result | 9 turns on voice2work → 27 nodes / 29 edges across 6 problem domains, 5 of 8 edge kinds + 4 of 9 node kinds exercised. **Codemap thesis validated.** |
| Test suite | Run `bun test` before shipping; integration tests pin the MCP lifecycle contract |
| CI | green on every PR; `publish-dryrun` job is the strict gate |

**Read these two retros before doing anything** — they have the M3 ground truth + open findings:
- [`tasks/task-020-m3a-retrospective.md`](tasks/task-020-m3a-retrospective.md) — the M3a retro (cold-start trial)
- [`tasks/task-024-m3b-retrospective.md`](tasks/task-024-m3b-retrospective.md) — the M3b retro (warm-graph trial + decision-kind elicitation)

## What's next: behavior consistency

The user explicitly parked visual work until Codemap's behavior is consistent. The current product priority is graph quality:

| Rank | Focus | Why |
| --- | --- | --- |
| 1 | **Codebase-only writeback** | The graph is valuable only if it captures durable repo knowledge, not arbitrary chat, external docs, or one-off research. |
| 2 | **Instruction discipline** | Agents should query/write for repo tasks, but leave the graph alone for unrelated user questions. |
| 3 | **Server-side guardrails** | MCP tools are model-controlled, so the server must reject writes that are not anchored to real repo files. |
| 4 | **Dogfood on real code tasks** | Verify the graph stays useful across follow-up repo work before adding retrieval upgrades or UI. |

Visual surfaces, including editor extensions and graph viewers, are deferred. Re-open them only after codebase-scoped behavior feels trustworthy. A local source-index slice now exists for cold-start code discovery, and `query_context` fuses it with graph memory for pre-planning. `graph_health` exposes stale or duplicated graph memory without writing repairs. The CLI `codemap doctor` defaults to compact human output; use `--json` for the full structured health report. Keep the source index separate from graph memory and do not auto-generate graph nodes from it.

Task 033 shipped `codemap-mcp@0.5.1` as a patch release for the merged
post-0.5.0 polish: compact doctor output, safer CLI flushing, and the
professional public README/package metadata.

After the DeepContext/GitNexus/codebase-memory/Serena comparison, the next
Phase 4 sequence is behavior-first competitive hardening:

1. task-034 — agent compliance and onboarding
2. task-035 — `query_context` v2 retrieval
3. task-036 — TS/JS symbol and impact context
4. task-037 — memory quality and ranking
5. task-038 — workflow auto-capture suggestions

Task 034 implements the first compliance slice: versioned generated-guidance
metadata plus `codemap init --check`, a read-only freshness check for
`AGENTS.md` / `CLAUDE.md`. The goal is to make agents use Codemap correctly
without chat reminders before adding more retrieval machinery.

Task 039 prepares `codemap-mcp@0.5.2` so the merged task-034 onboarding work can
ship before task 035 starts. It should remain a patch release: version bump,
release gates, PR, then npm/GitHub publish after merge.

## How to work in this repo (the conventions)

These were learned during M3, not in any spec — propagate them.

### Cadence

- **Option B**: one task per PR. Surface decisions in the task file before implementing. Get user signoff on decisions, then build.
- Each PR includes: code/docs, version bump if applicable, tests, smoke test, publish-dry-run check, task file in `tasks/` updated.
- Greptile bot reviews PRs — address P1 findings before merge.

### Commits

- **NEVER** include assistant/provider attribution trailers. Pure-content commits only.
- **NEVER** add generated-by footers to PR bodies, issue bodies, comments, release notes, or branch names. Same rule, broader scope.
- Branch names, commit messages, PR titles, release names, and release notes must use neutral product/task wording only. Use names like `release-v0.3.0` or `source-index-status`, with no assistant/tool/vendor attribution.
- Concise commit messages, lead with the why. HEREDOC for multi-line.

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
- Use the lifecycle in `AGENTS.md` for any codemap-source task: `set_active_topic` → `query_context` (or `query_graph` + optional `search_source`; `graph_health` when graph memory looks stale) → emit findings → link relationships.

## Critical files map

```
codemap/
├── V1_SPEC.md                     spec source of truth
├── TECH_SPEC.md                   technical decisions
├── ROADMAP.md                     milestones + parked v2 candidates
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
│   ├── tools/                     MCP tool implementations
│   │   ├── _active_topic.ts       module-scoped per-turn state + cap counter
│   │   ├── set_active_topic.ts
│   │   ├── query_context.ts       fused graph/source planning context
│   │   ├── graph_health.ts        read-only graph validation + source staleness health
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
│   │   ├── doctor.ts              graph health CLI wrapper
│   │   └── rollup.ts
│   ├── schema.ts                  zod schemas for graph file (Node, Edge, GraphFile, etc.)
│   ├── graph.ts                   GraphStore class (load/save/query/upsert/etc.) with proper-lockfile
│   ├── validator.ts               validate() + applyRepairs() for graph integrity
│   ├── collision.ts               weighted similarity for emit_node dedup
│   ├── metrics.ts                 telemetry per-turn + weekly rollup
│   └── index.ts                   registerTools() — wires graph and source-index MCP tools
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
| F5 | Agent invents round-number future timestamps for `last_verified_at` | Description tightening plus the ±5 minute future guard have shipped; keep watching in dogfood, but the write path now rejects obvious future timestamps. |
| F7 | `implements` edge kind unexercised | Agent refuses to fabricate `concept` nodes (V1_SPEC-correct). Will likely surface only in TS-with-interfaces / Java / Go codebases. |
| — | M3b-4 isolation test deferred | Optional 10-min experiment: does `codemap init`-generated AGENTS.md remain necessary, or does v0.2.0's improved Codex behavior alone suffice? Useful data point, not blocking. |
| — | `codemap rollup` real-data dogfood | Verified on 2026-05-04 against this repo's local graph/metrics; produced a sensible weekly aggregate. Keep using it after release tasks. |
| — | M3c (cross-codebase) skipped | User chose to close M3 without it. task-011 is still drafted if anyone wants to revisit later. |
| — | Visual graph work parked | Do not rebuild editor/viewer surfaces until behavior consistency and graph quality are explicitly accepted. |

## How to ship a release (recipe)

1. Branch `<task-slug>` off main.
2. Code + tests + task file update.
3. `bun run typecheck && bun test && ./scripts/smoke-test.sh` — must all be clean locally.
4. `npm publish --dry-run --provenance --access public` — must show **zero** `npm warn publish` lines.
5. Bump `package.json`; the CLI and MCP server read the version from `package.json`.
6. Commit with concise message, no agent attribution.
7. Push, open PR, address greptile P1.
8. After CI green + user merges: `git checkout main && git pull && npm publish --access public` from local. (No `--provenance` from local — only works in CI.)
9. Verify: `npm view codemap-mcp version` shows new version. `npm i -g codemap-mcp@<v> --prefer-online` to upgrade local install.
10. Tag and publish the matching GitHub release (`v<version>`) with neutral release notes.

## Your first three actions

1. **Read this file plus the task index** so you start from the behavior-first pivot, not the removed visual-extension direction.
2. **Use Codemap only for repo work**: set a topic, query before planning, emit only durable findings anchored to real project files, and link relationships.
3. **Keep visual work parked** unless the user explicitly re-opens it after behavior consistency is good enough.

## Tone + working style notes (small but real)

- The user prefers concise, direct messages. No filler. No emojis unless they use them first.
- Surface decisions as numbered options with a recommendation. Don't make ambiguous choices unilaterally on architectural calls.
- Use the codemap MCP server while working in this repo. Set a topic, query first, emit findings, link relationships. The repo's own `AGENTS.md` has the lifecycle.
- When you commit/PR/release: triple-check no agent attribution slips in. The user has called this out twice — don't be the third.
- The user is a single-dev personal project owner with limited time. Prefer cheap experiments over expensive ones; prefer shipping over polishing.

Good luck. The hard parts (M2 server, M3 validation) are done. The next hard part is quieter: keep the graph clean enough that future agents can trust it.
