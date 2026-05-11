# Task 053 — Watch mode and freshness daemon

Status: done

Phase: Phase 4 / performance

## Intent

Keep the rebuildable source index fresh automatically so agents do not have to
remember to re-scan before every meaningful repository task.

## Context

Viberag and Vera both lean on watch/update workflows. Codemap already reports
freshness, but the best agent experience is for the index to update in the
background and surface health status before stale context reaches the model.

## Deliverables

- [x] Add `codemap watch` as a polling freshness command.
- [x] Refresh the source index automatically when watched status detects
  missing, stale, or invalid index state.
- [x] Expose watcher status through `codemap watch --status` and the
  `watch_status` MCP tool.
- [x] Keep graph memory writes separate from index refreshes.

## Exit Criteria

- [x] File changes update source-index freshness without manual `scan`.
- [x] Agents can query watcher/index health cheaply.
- [x] Watch mode never writes curated graph memory.

## Notes

The first version can be polling-based if it keeps the interface simple and
portable.

Implemented as a portable polling loop rather than native `fs.watch`.
`codemap watch` runs continuously and emits one JSON event per check.
`codemap watch --once` performs a single check and refresh, and
`codemap watch --status` reads watcher/source freshness without refreshing.
Watch state is written under the rebuildable `.codemap/index/watch.json` cache;
`.codemap/graph.json` is never created or modified by watch mode.
