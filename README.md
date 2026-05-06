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
- inspect stale or missing source anchors before trusting old knowledge
- search local source chunks when the graph is empty or incomplete
- correct or deprecate graph knowledge from the CLI when humans know better

Codemap is not general chat memory. It is for durable knowledge about the
current codebase.

## How It Works

1. An agent starts a task and queries the graph for related repo knowledge.
2. If needed, Codemap searches a local source index to help the agent find
   relevant files faster.
3. After inspecting real project files, the agent writes only durable findings
   back to the graph.
4. Future agents can reuse, update, link, or deprecate that knowledge instead
   of starting from zero.

The graph and the source index are intentionally separate:

- `.codemap/graph.json` is curated memory: decisions, invariants, gotchas, and
  relationships.
- `.codemap/index/source.json` is a disposable cache for code discovery. It can
  be rebuilt at any time and never creates graph nodes by itself.

## Install

Requires Node.js 22 or newer.

```sh
npm install -g codemap-mcp
```

This installs two commands:

- `codemap-mcp` — the MCP stdio server
- `codemap` — the CLI for setup, inspection, health checks, and source indexing

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
   source-index status, source search, dependency/impact context, match reasons,
   stale-anchor warnings, and next steps.
3. Inspect real project files before relying on search results.
4. `emit_node` only for durable repo-local knowledge, anchored to real source
   files.
5. `link` related nodes when one decision, invariant, or gotcha depends on
   another.

Codemap intentionally rejects low-quality graph writes. `emit_node` requires
real repo-relative source files and matching content hashes; it rejects empty,
absolute, missing, path-escaping, or external URL anchors. It also caps writes
per turn to prevent graph spam.

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `set_active_topic` | Mark the current task and reset the per-turn emit budget. |
| `query_context` | Preferred planning tool. Combines quality-ranked graph memory, source search, staleness, match reasons, dependencies, impact context, and next steps. |
| `query_graph` | Search curated graph memory for relevant nodes, edges, match reasons, and trust metadata. |
| `get_node` | Fetch one node by id or alias. |
| `graph_health` | Read-only graph health report: validator warnings and source-anchor staleness. |
| `emit_node` | Create or merge a durable repo-local finding. |
| `link` | Create or update a typed relationship between two nodes. |
| `index_codebase` | Build the rebuildable local source index. |
| `search_source` | Search indexed source chunks with score breakdowns, match reasons, and optional import/importer plus symbol/file impact context. |
| `get_index_status` | Check whether the source index exists and looks fresh. |
| `clear_index` | Delete the source-index cache without touching graph memory. |

Supported edge kinds:

`imports`, `calls`, `depends_on`, `implements`, `replaces`, `contradicts`,
`derived_from`, `mirrors`

## CLI

The `codemap` CLI lets humans inspect, repair, and audit the graph.

```sh
codemap init                          # Generate agent guidance for this repo
codemap init --check                  # Check generated guidance freshness
codemap show <id>                     # Print a node and its incident edges
codemap correct <id> --summary "..."  # Override node fields by hand
codemap deprecate <id> --reason "..." # Mark stale knowledge as deprecated
codemap validate                      # Validate and dry-run graph repairs
codemap doctor                        # Compact graph health summary
codemap doctor --json                 # Full structured health report
codemap scan                          # Build the local source index
codemap context "auth guard"          # Graph + source context for planning
codemap search-source "auth guard"    # Search indexed source chunks
codemap search-source "requireActiveUser" --include-impact
codemap index-status                  # Report source-index freshness
codemap clear-index                   # Delete the rebuildable source index
codemap --help                        # Full command reference
```

By default, commands operate on the current working directory. Use
`--repo <path>` to target a different repository.

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

## Memory Quality

Graph search results include query-time trust metadata. Codemap keeps the graph
schema stable and computes quality from existing fields: lexical match score,
confidence, node kind, verification age, deprecated status, and source-anchor
freshness.

Each graph match can include:

- `ranking_score` — match score adjusted by memory quality
- `quality.trust` — `high`, `medium`, or `low`
- `quality.freshness` — `fresh`, `stale`, `unchecked`, or `no_sources`
- `quality.reasons` — short hints explaining why the memory ranked that way

`query_context.graph.memory_quality` groups returned node ids into
`high_trust_node_ids`, `review_node_ids`, `stale_node_ids`, and
`low_trust_node_ids`. Low-trust memories are not hidden; agents should inspect
their source anchors before relying on them.

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
