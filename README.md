# Codemap

Persistent knowledge graph of a codebase, built incrementally by AI agents during normal work, exposed via [MCP](https://modelcontextprotocol.io). Stored as a single JSON file in your repo (`.codemap/graph.json`) — diffable, reviewable, no database required.

**Status:** v0.1.0 — M2 milestone (5 MCP tools + CLI + telemetry + npm distribution). M3 trial pending.

See [`V1_SPEC.md`](V1_SPEC.md) for what we're building, [`TECH_SPEC.md`](TECH_SPEC.md) for how, and [`ROADMAP.md`](ROADMAP.md) for when.

## Install

Requires Node 22+. No Bun required at runtime — the published bundle is plain Node-compatible JS.

```sh
# Global install (CLI + MCP server on PATH)
npm install -g codemap-mcp

# Or one-shot via npx
npx -y codemap-mcp --help
```

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

## The 5 MCP tools

| Tool | When the agent calls it |
| --- | --- |
| `set_active_topic` | Start of a task. Tags subsequent emissions; resets the per-turn cap counter. |
| `query_graph` | Find existing nodes relevant to a task description. Call this **before** planning. |
| `get_node` | Fetch a specific node + its incident edges by id or alias. |
| `emit_node` | Add or merge a node. Capped at 5 per turn (per `V1_SPEC` §7.5) to prevent spam. Detects collisions with existing nodes via name/alias/source/tag similarity. |
| `link` | Create or update an edge between two existing nodes. Idempotent on `(from, to, kind)`. |

Edge kinds (V1_SPEC §6.2): `imports`, `calls`, `depends_on`, `implements`, `replaces`, `contradicts`, `derived_from`, `mirrors`.

## CLI

The `codemap` command is a manual inspector and corrector for the graph. Use it when you want to override the agent's view by hand.

```sh
codemap show <id>                     # Print a node + incident edges
codemap correct <id> --summary "..."  # Override fields (bypasses agent merge logic)
codemap deprecate <id> --reason "..." # Mark a node deprecated
codemap validate                      # Dry-run validator (exit 0 clean / 1 warnings / 2 schema-invalid)
codemap rollup                        # Compute the metrics weekly rollup
codemap --help                        # Full reference
```

By default `codemap` operates on the current working directory; pass `--repo <path>` to target a different repo root.

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
