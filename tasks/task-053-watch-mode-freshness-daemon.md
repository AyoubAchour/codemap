# Task 053 — Watch mode and freshness daemon

Status: todo

Phase: Phase 4 / performance

## Intent

Keep the rebuildable source index fresh automatically so agents do not have to
remember to re-scan before every meaningful repository task.

## Context

Viberag and Vera both lean on watch/update workflows. Codemap already reports
freshness, but the best agent experience is for the index to update in the
background and surface health status before stale context reaches the model.

## Deliverables

- Add `codemap watch` or an equivalent background freshness command.
- Incrementally refresh changed files where possible.
- Expose watcher status through CLI and MCP.
- Keep graph memory writes separate from index refreshes.

## Exit Criteria

- [ ] File changes update source-index freshness without manual `scan`.
- [ ] Agents can query watcher/index health cheaply.
- [ ] Watch mode never writes curated graph memory.

## Notes

The first version can be polling-based if it keeps the interface simple and
portable.
