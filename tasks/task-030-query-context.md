# Task 030 — `query_context` fusion tool

Status: done

Target version: 0.4.0

## Why

After v0.3.0, agents can discover source context, but they still have to
manually choreograph `query_graph`, staleness checks, source-index status,
`index_codebase`, and `search_source`. Since MCP tool choice is model-controlled,
the best behavior improvement is a single pre-planning read that returns the
context an agent actually needs.

## Scope

- Add shared `buildQueryContext()` core logic.
- Add MCP tool `query_context`.
- Add CLI command `codemap context`.
- Include graph matches, source staleness, source-index status/search,
  deduplicated related nodes, warnings, and next steps.
- Keep the source index rebuildable and separate from curated graph memory.
- Deduplicate `related_nodes` returned by source search when a graph node has
  multiple anchors in the same file.

## Exit Criteria

- `query_context` is listed by MCP `tools/list` and returns structured content.
- `codemap context "<question>"` works without a pre-existing source index by
  defaulting to `refresh_index: if_missing`.
- Existing `search_source` related nodes are deduplicated by node id.
- README, handoff, spec, roadmap, and generated agent guidance describe the new
  pre-planning path.
- `bun test`, `bun run typecheck`, `bun run build`, smoke test, and publish
  dry-run pass.
