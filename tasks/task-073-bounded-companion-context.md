# Task 073: Bounded Companion Context

**Status:** done
**Phase:** Phase 4 / retrieval
**Estimate:** 1 day
**Depends on:** task-072
**Blocks:** future retrieval ranking and semantic-provider tuning

## Goal

Surface useful adjacent files from the local source index without increasing
query limits, response budgets, or runtime semantic complexity.

## Context

Task 072 showed that primary retrieval was healthy, while many remaining misses
were nearby companion files: CLI wrappers, MCP tool adapters, unit tests,
generated agent guidance, and task indexes. Those files are often useful to an
agent, but broadening result limits would increase payload size and risk more
noise. The next optimization should use relationships the source index already
knows instead of adding a semantic provider.

## Deliverables

- Add bounded companion expansion to source search after weak-result filtering.
- Use local import relationships to surface CLI/tool wrappers for matching core
  source files.
- Surface same-stem unit-test companions for matching source implementations.
- Surface generated agent guidance and writeback companions only for lifecycle
  or writeback-shaped queries.
- Surface the task index for task-documentation queries.
- Keep primary benchmark hit rate, forbidden-file rate, and payload compliance
  intact.

## Exit Criteria

- [x] Unit coverage proves CLI/tool, unit-test, AGENTS, and setup-query
  companion behavior.
- [x] `bun test test/unit/source_index.test.ts` passes.
- [x] Planning benchmark gate preserves primary file hit rate and payload
  compliance at `1.0`.
- [x] Recall benchmark gate preserves primary file hit rate and payload
  compliance at `1.0` under the `65000` byte average response target.
- [x] No runtime semantic provider is enabled by this task.

## Notes

Companion hits are rebuildable source-index evidence, not curated graph memory.
They are injected in a small bounded lane and still go through normal result
diversification and byte-budget trimming in higher-level context tools.
