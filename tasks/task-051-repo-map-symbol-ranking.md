# Task 051 — Repo map and symbol graph ranking

Status: done

Phase: Phase 4 / retrieval

## Intent

Build a lightweight automatic repo map over files, symbols, imports,
references, tests, and docs, then use graph ranking to improve agent context.

## Context

Aider's repo map and GitNexus-style precomputed context show that agents get
better results when file and symbol importance is computed before the LLM asks
follow-up questions. Codemap already indexes symbols/imports/references; the
next step is to turn that source-index data into a ranking layer.

## Deliverables

- Build a source-index-derived file/symbol graph.
- Add centrality/PageRank-style scoring for important files and definitions.
- Use ranking in `query_context`, `changes_context`, and generated repo
  guidance.
- Keep the automatic repo map separate from curated graph memory.

## Delivered

- Added a deterministic source-index-derived repo map over local imports and
  exact reference names.
- Added weighted PageRank-style file centrality plus query and change-seed
  scoring.
- Added symbol ranking from file rank, export status, and reference counts.
- Surfaced compact repo map summaries in `query_context`, `changes_context`,
  and generated repo guidance area files.
- Kept repo map output explicitly rebuildable and separate from curated graph
  memory.

## Verification

- `bun run typecheck`
- `bun test test/unit/repo_map.test.ts test/unit/cli.test.ts test/integration/mcp.test.ts --timeout 30000`
- `git diff --check`
- `bunx biome check src/repo_map.ts test/unit/repo_map.test.ts`

## Exit Criteria

- [x] Repo map ranking is deterministic and local-only.
- [x] Ranked context is exposed as compact summaries for planning and diff
      review. Benchmark tuning can continue in Task 055.
- [x] Generated guidance highlights high-centrality areas without treating them
      as durable graph memory.

## Notes

Start TS/JS-first using existing source-index references. Multi-language graph
expansion can follow after the ranking model proves useful.
