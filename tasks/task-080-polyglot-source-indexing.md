# Task 080: Polyglot Source Indexing

**Status:** done
**Phase:** Phase 4 / retrieval
**Estimate:** 1 day
**Depends on:** task-079
**Blocks:** future non-TypeScript repository dogfooding

## Goal

Make the rebuildable source index useful on scrcpy-class and broader polyglot
repositories without adding runtime parser, embedding, or vector dependencies.

## Context

Dogfooding on `genymobile/scrcpy` showed that Codemap 0.9.2 indexed Markdown
guidance and docs but skipped the actual C, Java, Meson, and Gradle source
surface. That made `search-source`, `context`, `recall-context`,
`changes-context`, and repo-map summaries mechanically healthy but weak for
non-TypeScript projects.

## Deliverables

- Source index recognizes C, C headers, C++, Java, Gradle, Meson, Go, Rust,
  Python, C#, and Kotlin files.
- Fallback extractors provide conservative symbols and imports for those
  languages.
- Repo-map relationship resolution handles local C/C++ include edges and broad
  test-file roles.
- A tiny polyglot benchmark fixture protects source retrieval across the
  broader language batch.
- Existing TS/JS AST extraction, payload budgets, and retrieval benchmark gates
  remain unchanged.

## Exit Criteria

- [x] `bun test test/unit/source_index.test.ts`
- [x] `bun test test/unit/repo_map.test.ts`
- [x] `bun test test/unit/retrieval_benchmark.test.ts`
- [x] `bun run typecheck`
- [x] `bun test`
- [x] `bun run build`
- [x] `git diff --check`
- [x] Planning retrieval benchmark keeps file hit rate and payload compliance
  at 1.
- [x] Polyglot fixture benchmark keeps file hit rate at 1 with no forbidden file
  hits.

## Notes

This task intentionally avoids exact non-TypeScript references and full language
parsers. The value is broad, local-first source discovery that gives agents the
right files to inspect.
