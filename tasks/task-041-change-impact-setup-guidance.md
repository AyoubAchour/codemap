# Task 041 — Change impact, setup, stale nudges, and generated guidance

Status: done

Phase: Phase 4 / behavior consistency

## Intent

Borrow the strongest workflow advantages from graph-backed codebase-memory tools
without changing Codemap's core identity as curated repo memory. Agents should
get better help around diffs, setup, stale indexes, and generated orientation
while graph writes remain deliberate and source-anchored.

## Delivered

- Added `changes_context` MCP tool and `codemap changes-context` CLI command.
- Added `codemap setup` for global MCP client configuration and install-health
  checks.
- Added source-search stale-index warnings so agents get nudged before trusting
  old source hits.
- Added `codemap generate-skills` for generated repo-local orientation guidance
  under `.codemap/skills/`, explicitly separate from curated graph memory.
- Updated generated lifecycle instructions so agents use `changes_context`
  before committing, reviewing, or summarizing diffs.

## Exit Criteria

- [x] Diff context reports changed files, changed ranges, source impact,
      graph anchors, likely tests/docs, and writeback prompts.
- [x] Global setup can write/check Codex, Cursor, and OpenCode config snippets
      and returns manual setup guidance for CLI-managed clients.
- [x] Generated repo guidance is checkable and marked as generated, not proof.
- [x] MCP tool list includes `changes_context`.
- [x] Unit and integration tests cover the new surfaces.

## Verification

- `bun run typecheck`
- `bun test`
- `bun run build`

`bun run lint` still reports pre-existing Biome formatting/no-non-null
diagnostics across untouched files, so it is not a clean gate for this slice.
