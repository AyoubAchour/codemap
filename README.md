# Codemap

Persistent knowledge graph of a codebase, built incrementally by AI agents during normal work, exposed via [MCP](https://modelcontextprotocol.io). Stored as a single JSON file in your repo (`.codemap/graph.json`) — diffable, reviewable, no database required.

**Status:** v0.5.0 target — **M3 closed** ([M3a retro](tasks/task-020-m3a-retrospective.md), [M3b retro](tasks/task-024-m3b-retrospective.md)): 9 turns on voice2work produced 27 nodes / 29 edges across 6 problem domains; 5 of 8 edge kinds + 4 of 9 node kinds exercised; 0 collisions. Codemap thesis validated. **Current focus:** behavior consistency, codebase-only graph quality, and fused local source discovery before any human-facing visual surface. For agent handoff context see [`HANDOFF-CODEX.md`](HANDOFF-CODEX.md).

See [`V1_SPEC.md`](V1_SPEC.md) for what we're building, [`TECH_SPEC.md`](TECH_SPEC.md) for how, and [`ROADMAP.md`](ROADMAP.md) for when.

## Install

Requires Node 22+. No Bun required at runtime — the published bundle is plain Node-compatible JS.

```sh
# 1. Install globally (puts `codemap` and `codemap-mcp` on PATH)
npm install -g codemap-mcp

# 2. Wire it into your MCP client (see "Configure your MCP client" below)

# 3. In each project where you want to use codemap, drop AGENTS.md
#    so the lifecycle policy reaches the agent regardless of the
#    MCP client's behavior:
cd /path/to/your-project
codemap init
```

The third step is required for MCP clients that drop the server's `instructions` field (Codex Desktop as of 2026-04). Without `AGENTS.md` the agent will treat codemap as a read-only cache and never write back. See [Agent guidance](#agent-guidance) for details.

## Configure your MCP client

### Claude Code

Add to `~/.config/claude-code/mcp.json` (or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "codemap": {
      "command": "codemap-mcp"
    }
  }
}
```

The server reads `process.cwd()` to find the repo root. Run Claude Code from your project directory and `.codemap/graph.json` will be created/read there.

### Other MCP clients

Any client that supports stdio MCP servers works. Point `command` at the `codemap-mcp` binary on your PATH.

## MCP tools

| Tool | When the agent calls it |
| --- | --- |
| `set_active_topic` | Start of a task. Tags subsequent emissions; resets the per-turn cap counter. |
| `query_context` | Preferred pre-planning read for repo work. Fuses graph matches, source-index status/search, staleness, related graph nodes, dependency context, warnings, and next steps. |
| `query_graph` | Find existing nodes relevant to a codebase task description. Call this **before** planning repo work. |
| `get_node` | Fetch a specific node + its incident edges by id or alias. |
| `graph_health` | Inspect graph validator issues and source-anchor staleness. Read-only; useful when returned graph memory looks stale or duplicated. |
| `emit_node` | Add or merge a durable repo-local finding. Capped at 5 per turn (per `V1_SPEC` §7.5) to prevent spam. Requires real repo-relative source files and rejects empty, absolute, missing, escaping, or external URL anchors. Detects collisions with existing nodes via name/alias/source/tag similarity. |
| `link` | Create or update an edge between two existing nodes. Idempotent on `(from, to, kind)`. |
| `index_codebase` | Build the rebuildable local source index for this repo. Does not create graph nodes. |
| `search_source` | Search indexed source chunks for relevant code before inspecting files directly; can include nearby import/importer context. |
| `get_index_status` | Check whether the local source index exists and whether indexed files look fresh. |
| `clear_index` | Delete the rebuildable source-index cache without touching `.codemap/graph.json`. |

Edge kinds (V1_SPEC §6.2): `imports`, `calls`, `depends_on`, `implements`, `replaces`, `contradicts`, `derived_from`, `mirrors`.

The source index is a disposable cache at `.codemap/index/source.json`. It is separate from the curated graph: use it for cold-start source discovery, then inspect files and emit only durable decisions, invariants, gotchas, and relationships.

## CLI

The `codemap` command is a manual inspector and corrector for the graph. Use it when you want to override the agent's view by hand.

```sh
codemap init                          # Generate AGENTS.md (run once per project; --force to overwrite, --claude adds CLAUDE.md)
codemap show <id>                     # Print a node + incident edges
codemap correct <id> --summary "..."  # Override fields (bypasses agent merge logic)
codemap deprecate <id> --reason "..." # Mark a node deprecated
codemap validate                      # Dry-run validator (exit 0 clean / 1 warnings / 2 schema-invalid)
codemap doctor                        # Graph health; --issue-limit controls stale-anchor detail
codemap rollup                        # Compute the metrics weekly rollup
codemap scan                          # Build the local source index cache
codemap context "auth guard"          # Fused graph + source + dependency context for planning
codemap search-source "auth guard"    # Search indexed source chunks; --dependency-limit adds imports/importers
codemap index-status                  # Report source-index freshness
codemap clear-index                   # Delete the rebuildable source index
codemap --help                        # Full reference
```

By default `codemap` operates on the current working directory; pass `--repo <path>` to target a different repo root.

## Agent guidance

The MCP server attaches a short lifecycle policy to the agent's system prompt at `initialize` time (per the MCP `instructions` field). Some MCP clients pick this up automatically; **some don't.** We've confirmed Codex Desktop drops it (M3a finding F1, [task-020](tasks/task-020-m3a-retrospective.md)).

The robust install path: run `codemap init` in your project to drop an `AGENTS.md` containing the same lifecycle policy. Codex (CLI + Desktop) reads `AGENTS.md` reliably; Claude Code reads `CLAUDE.md` (`codemap init --claude` or `--all`).

```sh
cd /path/to/your-project
codemap init           # writes ./AGENTS.md
codemap init --claude  # writes ./AGENTS.md and ./CLAUDE.md
codemap init --all     # writes every known agent-preamble file
codemap init --force   # overwrite existing files (e.g. after upgrading codemap-mcp)
```

The generated file mirrors `src/instructions.ts` — single source of truth. To regenerate after a codemap-mcp upgrade: `codemap init --force`.

Codemap is intentionally **not** general conversation memory. Agents should use it only when the request touches the current repository's code, docs, architecture, roadmap, tests, or build/release behavior. General Q&A, web research, install help, recommendations, and unrelated user questions should leave `.codemap/graph.json` untouched.

## Telemetry

Codemap writes per-turn counters and weekly rollups to `<repo>/.codemap/metrics.json` for local visibility into agent behavior (queries per turn, emission rate, collisions, cap hits). **No network. No PII. Counts only.** The file is committed to git so the team can see it diff over time.

Opt out at any time:

```sh
export CODEMAP_TELEMETRY=false   # tool-specific
# or
export DO_NOT_TRACK=1            # cross-tool industry standard
```

## Development

This repo is itself developed via the option-B cadence (one task per PR; see [`tasks/`](tasks/)). To work on Codemap locally:

```sh
bun install
bun test
bun run typecheck
bun run build           # bundles bin/* → dist/cli/*.js
```

Run the bundled MCP server against your project:

```json
{
  "mcpServers": {
    "codemap": {
      "command": "node",
      "args": ["/abs/path/to/codemap/dist/cli/codemap-mcp.js"]
    }
  }
}
```

## License

MIT
