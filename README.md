# Codemap

Persistent codebase memory for MCP-enabled coding agents.

Codemap gives agents a small, reviewable knowledge graph for each repository.
It captures the things that are easy to lose between sessions: architectural
decisions, invariants, gotchas, important relationships, and the source files
that prove them.

Everything stays local. The curated graph is stored as JSON in your repo at
`.codemap/graph.json`; the source index is a rebuildable cache; no database or
hosted service is required.

## Why Use Codemap?

AI coding agents are good at reading a repo once. They are much less reliable at
remembering what mattered the next time.

Codemap helps by giving them a shared, repo-scoped memory:

- preserve decisions and constraints that are not obvious from one file
- reduce repeated rediscovery across sessions and tools
- keep findings anchored to real source files
- inspect changed or missing source anchors before trusting old knowledge
- search local source chunks when the graph is empty or incomplete
- correct or deprecate graph knowledge from the CLI when humans know better

Codemap is not general chat memory. It is for durable knowledge about the
current codebase.

## How It Works

1. An agent starts a task and queries the graph for related repo knowledge.
2. If needed, Codemap searches a local source index to help the agent find
   relevant files faster.
3. Before reviewing or finishing a diff, Codemap can map changed files to
   source-index impact context, stale graph anchors, likely affected tests/docs,
   and writeback prompts.
4. After inspecting real project files, the agent writes only durable findings
   back to the graph.
5. Future agents can reuse, update, link, or deprecate that knowledge instead
   of starting from zero.

The graph and the source index are intentionally separate:

- `.codemap/graph.json` is curated memory: decisions, invariants, gotchas, and
  relationships.
- `.codemap/index/source.json` is a disposable cache for code discovery. It can
  be rebuilt at any time and never creates graph nodes by itself.
- `.codemap/index/capture/events.jsonl` is rebuildable session evidence for
  audit and future suggestions. It can be deleted without corrupting graph
  memory.
- `.codemap/index/capture/sessions.json` and
  `.codemap/index/capture/profile.json` are rebuildable summaries derived from
  capture events. They help recall long-running work but are not graph memory.
- Repo map rankings are rebuildable source-index signals: they help agents pick
  high-value files and symbols to inspect, but they are not durable memory.

## Latest Release

Version `0.8.0` includes:

- read-only graph repair planning for stale, missing, unsafe, and legacy source
  anchors
- source-index-derived repo map rankings for `query_context`,
  `changes_context`, and generated guidance
- `codemap watch` plus `watch_status` to keep the rebuildable source index fresh
- richer graph memory quality signals for utility, maturity, usage,
  source-confirmation, and supersession
- a larger offline retrieval benchmark suite with optional semantic/reranker
  adapter hooks disabled by default

See [CHANGELOG.md](CHANGELOG.md) for full release notes.

## Install

Requires Node.js 22 or newer.

```sh
npm install -g codemap-mcp
```

This installs two commands:

- `codemap-mcp` — the MCP stdio server
- `codemap` — the CLI for setup, inspection, health checks, and source indexing

To configure supported MCP clients from one place:

```sh
codemap setup
codemap setup --check
codemap setup --capture-hooks --client codex
codemap setup --capture-hooks --client codex --check
```

`setup` can write global Codemap entries for Codex, OpenCode, and Cursor, and
prints the manual command for clients that manage MCP through their own CLI. It
also checks whether the configured server command is available on `PATH`.
Capture hooks are opt-in: `--capture-hooks` installs or checks Codex hooks that
append rebuildable session evidence with `codemap capture-event`. They do not
call graph write tools and they never modify `.codemap/graph.json`.

## Configure Your MCP Client

Add Codemap as a stdio MCP server:

```json
{
  "mcpServers": {
    "codemap": {
      "command": "codemap-mcp"
    }
  }
}
```

Run your MCP client from the repository root. Codemap uses the process working
directory to find or create `.codemap/graph.json`.

You can also use Codemap without a global install:

```json
{
  "mcpServers": {
    "codemap": {
      "command": "npx",
      "args": ["-y", "codemap-mcp"]
    }
  }
}
```

## Initialize A Project

In each repo where you want agents to use Codemap:

```sh
cd /path/to/your-project
codemap init
```

This writes an `AGENTS.md` file with the Codemap lifecycle policy. Keeping the
policy in the repo makes behavior consistent even when a client does not forward
MCP server instructions to the agent.

Useful variants:

```sh
codemap init --check   # verify generated guidance is current without writing
codemap init --force   # overwrite an existing generated file
codemap init --all     # write every supported agent guidance file
```

Generated guidance includes a Codemap version and lifecycle-policy hash. After
upgrading `codemap-mcp`, run `codemap init --check`; if it reports stale or
missing guidance, regenerate with `codemap init --force`.

## Agent Workflow

For repository tasks, agents should follow this loop:

1. `set_active_topic` to name the task and reset per-turn write limits.
2. `query_context` before planning. This combines quality-ranked graph memory,
   source-index status, source search, repo map rankings, dependency/impact
   context, match reasons, stale-anchor warnings, and next steps.
3. Inspect real project files before relying on search results.
4. Run `changes_context` before committing, reviewing, or summarizing a diff.
   It maps changed files to indexed symbols, impact context, stale graph nodes,
   likely tests/docs, repo map impact, and read-only writeback suggestions.
5. Run `suggest_writeback` near the end when useful. It is read-only and turns
   inspected files, changed files, and a work summary into possible writeback
   prompts.
6. `emit_node` only for durable repo-local knowledge, anchored to real source
   files.
7. `link` related nodes when one decision, invariant, or gotcha depends on
   another.

Codemap intentionally rejects low-quality graph writes. `emit_node` requires
real repo-relative source files and matching content hashes; it rejects empty,
absolute, missing, path-escaping, or external URL anchors. It also caps writes
per turn to prevent graph spam.

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `set_active_topic` | Mark the current task and reset the per-turn emit budget. |
| `query_context` | Preferred planning tool. Combines quality-ranked graph memory, source search, repo map rankings, staleness, match reasons, dependencies, impact context, and next steps. Supports `compact`, `standard`, and `full` response modes. |
| `recall_context` | Compact recall tool. Returns a byte-budgeted packet with explicit graph/source provenance, optional capture-summary evidence, trust/freshness warnings, source anchors, and omitted-result counts. |
| `changes_context` | Diff-aware planning tool. Maps git changes to source impact context, repo map rankings, stale graph anchors, likely tests/docs, and read-only writeback prompts. |
| `query_graph` | Search curated graph memory for relevant nodes, edges, match reasons, and trust metadata. |
| `get_node` | Fetch one node by id or alias. |
| `graph_health` | Read-only graph health report: validator warnings and source-anchor staleness. |
| `graph_repair` | Read-only repair planner for stale, range-fresh, missing, unsafe, or legacy source anchors. |
| `suggest_writeback` | Read-only end-of-task prompts for possible durable writeback. Never creates nodes or links. |
| `emit_node` | Create or merge a durable repo-local finding. |
| `link` | Create or update a typed relationship between two nodes. |
| `index_codebase` | Build the rebuildable local source index. |
| `search_source` | Search indexed source chunks with score breakdowns, match reasons, and optional import/importer plus symbol/file impact context. |
| `get_index_status` | Check whether the source index exists and looks fresh. |
| `watch_status` | Check source-index watcher state and freshness without refreshing or writing graph memory. |
| `clear_index` | Delete the source-index cache without touching graph memory. |

Supported edge kinds:

`imports`, `calls`, `depends_on`, `implements`, `replaces`, `contradicts`,
`derived_from`, `mirrors`

## CLI

The `codemap` CLI lets humans inspect, repair, and audit the graph.

```sh
codemap init                          # Generate agent guidance for this repo
codemap init --check                  # Check generated guidance freshness
codemap setup                         # Configure global MCP clients
codemap setup --check                 # Check global MCP client configuration
codemap setup --capture-hooks --client codex
codemap setup --capture-hooks --client codex --check
codemap setup --capture-hooks --client codex --dry-run
codemap show <id>                     # Print a node and its incident edges
codemap correct <id> --summary "..."  # Override node fields by hand
codemap deprecate <id> --reason "..." # Mark stale knowledge as deprecated
codemap validate                      # Validate and dry-run graph repairs
codemap doctor                        # Compact graph health summary
codemap doctor --json                 # Full structured health report
codemap repair-graph                  # Read-only source-anchor repair proposals
codemap repair-graph --json           # Full structured repair report
codemap rollup                        # Compute the current weekly metrics rollup
codemap scan                          # Build the local source index
codemap watch                         # Keep the source index fresh by polling
codemap watch --once                  # Refresh once if the index is stale/missing
codemap watch --status                # Report watcher/source-index freshness
codemap context "auth guard"          # Graph + source context for planning
codemap context "auth guard" --mode compact
codemap recall-context "auth guard" --budget 2000
codemap recall-context "auth guard" --file src/auth.ts --symbol requireActiveUser
codemap recall-context "auth guard" --include-capture-summary
codemap capture-event file_inspected --session s1 --anchor src/auth.ts:1:12
codemap capture-session s1            # Summarize rebuildable capture evidence
codemap capture-summary s1            # Refresh session summaries and project profile
codemap capture-report --session s1 --json
codemap benchmark-retrieval           # Evaluate local retrieval against a suite
codemap changes-context               # Diff impact, stale graph anchors, tests/docs
codemap suggest-writeback --summary "what changed"
codemap suggest-writeback --capture-session s1 --summary "what changed"
codemap generate-skills               # Generate repo-local skill guidance and area slices
codemap generate-skills --check       # Check generated repo guidance freshness
codemap search-source "auth guard"    # Search indexed source chunks
codemap search-source "requireActiveUser" --include-impact
codemap index-status                  # Report source-index freshness
codemap clear-index                   # Delete the rebuildable source index
codemap --help                        # Full command reference
```

By default, commands operate on the current working directory. Use
`--repo <path>` to target a different repository.

Use `codemap recall-context` when an agent needs a small top-K packet rather
than full planning context. It supports `--mode mixed|graph|source`, `--limit`,
`--budget`, `--file`, `--symbol`, `--refresh-index`, and
`--include-capture-summary`. Every result says whether it came from curated
graph memory, the rebuildable source index, or rebuildable capture summaries.

Use `codemap capture-event` to append auditable session evidence such as prompts,
files inspected, files modified, Codemap calls, recall hits, suggestions, and
graph writes. Capture events live under `.codemap/index/capture/`, redact common
secret/token text before storage, and never modify `.codemap/graph.json`.
`codemap capture-session` summarizes one session for debugging and later
hook-driven capture work.
`codemap capture-summary` refreshes derived `sessions.json` and `profile.json`
files from the capture log. These files can be deleted and rebuilt; they help
recall recurring files, active areas, recent decisions, stale capture anchors,
and unresolved writeback opportunities without writing graph memory.
`codemap capture-report` is the read-only audit surface for the capture loop. It
prints a JSON report with per-session timelines, recall hits, writeback
suggestions, graph-write events, ignored malformed capture lines, stale anchors,
and any recall byte-budget fields captured in event payloads. Use
`--session <id>` to inspect one run and `--limit <n>` to constrain recent
events.

For Codex, `codemap setup --capture-hooks --client codex` writes a small
`~/.codex/codemap/capture-hook.mjs` helper and merges matching entries into
`~/.codex/hooks.json`. The generated hooks listen for Codex session start,
prompt submit, selected post-tool-use events, and stop events, then append
capture events only. Run `--check` to report missing or stale hook config
without writing files, or `--dry-run` to preview planned writes. Unsupported
clients get exact manual `capture-event` commands in the setup response instead
of brittle config edits.

`codemap benchmark-retrieval` looks for `benchmarks/retrieval.codemap.json` or
`.codemap/retrieval-benchmark.json` and reports offline baseline metrics for
the current retrieval stack: hit rate, precision/recall@K, MRR, diversity,
latency, response size, warning/source coverage, false-positive guardrails, and
lexical/graph/mixed/local-vector variant results. The bundled suite includes
semantic, typo, cross-file impact, renamed-symbol, stale-graph, docs, tests,
lifecycle, payload, and distractor cases, plus a small non-Codemap fixture under
`benchmarks/fixtures/`. Use it before adding heavier retrieval machinery.
Semantic retrieval and reranking are disabled by default. The CLI accepts
`--semantic-provider disabled`, `--semantic-provider local-hash`, and
`--reranker-provider disabled`; `local-hash` is a dependency-free benchmark-only
hashing-vector experiment over the existing source index.

## Graph Health

`codemap doctor` helps you decide whether graph memory is still trustworthy.

It reports:

- active and deprecated node counts
- checked source anchors
- changed, missing, unsafe, or unreadable anchors
- validator warnings and repairs
- suggestions for cleanup

The default output is readable in a terminal. Use `--json` when piping to other
tools.

`codemap repair-graph` turns graph-health source-anchor findings into concrete
read-only repair proposals. It separates range-unchanged anchors that can be
refreshed after inspection, changed ranges that need review, missing files that
may need deprecation, and legacy full-file anchors that should be upgraded to
range-aware source anchors.

## Memory Quality

Graph search results include query-time trust metadata. Codemap keeps the graph
schema backward-compatible and computes quality from lexical match score,
confidence, node kind, verification age, deprecated status, source-anchor
freshness, and optional lifecycle metadata.

Each graph match can include:

- `ranking_score` — match score adjusted by memory quality
- `quality.trust` — `high`, `medium`, or `low`
- `quality.freshness` — `fresh`, `stale`, `unchecked`, or `no_sources`
- `quality.signals` — utility, maturity, last-used, source-confirmation, and
  supersession metadata when present
- `quality.reasons` — short hints explaining why the memory ranked that way

New `emit_node` writes automatically mark source-verified memories as
`confirmed` and assign a conservative utility score based on node kind.
Agents can also pass an optional `quality` patch to update lifecycle signals;
for example, set `maturity: "confirmed"` and `superseded_by: null` when a
previously superseded memory is re-verified from source.
Existing graph files without quality metadata continue to load normally.
Low-utility or superseded memories are demoted, not hidden.

New graph writes store both a full-file hash and a cited-line-range hash. That
lets Codemap keep a memory fresh when unrelated code in the same file changes,
while still flagging the memory when the cited range itself changes.

`query_context.graph.memory_quality` groups returned node ids into
`high_trust_node_ids`, `review_node_ids`, `stale_node_ids`, and
`low_trust_node_ids`. `review_node_ids` is medium-trust memory. `stale_node_ids`
and `low_trust_node_ids` are diagnostic lists and may overlap. Low-trust
memories are not hidden; agents should inspect their source anchors before
relying on them.

## Writeback Suggestions

`suggest_writeback` is an end-of-task nudge, not an automatic memory writer. It
looks at explicit inspected or modified files, an optional work summary, the
active topic, and, on the CLI by default, git changed files. It returns possible
`decision`, `invariant`, `gotcha`, or `link` prompts with source-anchor
candidates.

It can also use rebuildable capture evidence with `--capture-session <id>` or
`--latest-capture-session`. Captured `file_inspected`, `file_modified`, and
`recall_hit` events add source candidates and are collapsed by file/reason so
repeated hook events do not spam suggestions.

Related graph memories in suggestions are quality-ranked, so high-utility,
fresh, source-confirmed memories appear before low-utility or superseded ones.
Stale related-memory ids are reported from that same ranked evidence scope, so
callers do not have to reconcile hidden stale candidates.
Suggestions are intentionally not durable memory. Agents must still inspect the
real files and call `emit_node` or `link` themselves.

## Local Metrics

Codemap can write local counters to `.codemap/metrics.json`, such as queries,
emits, collisions, and cap hits. These metrics are for repository visibility
only.

No network. No hosted analytics. No code contents are sent anywhere.

Disable local metrics with either environment variable:

```sh
export CODEMAP_TELEMETRY=false
export DO_NOT_TRACK=1
```

## What To Commit

Recommended:

- `.codemap/graph.json` — curated, reviewable project memory
- generated agent guidance files, such as `AGENTS.md`

Optional:

- `.codemap/metrics.json` if your team wants local behavior counters in git

Usually ignored:

- `.codemap/index/source.json` because it is a rebuildable cache
- `.codemap/skills/` because generated repo guidance can be regenerated

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

Run a local build as an MCP server:

```json
{
  "mcpServers": {
    "codemap": {
      "command": "node",
      "args": ["/absolute/path/to/codemap/dist/cli/codemap-mcp.js"]
    }
  }
}
```

## License

MIT
