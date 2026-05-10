# Task 049: Release v0.7.0

**Status:** in-progress
**Phase:** Phase 4 / release
**Started:** 2026-05-10
**Depends on:** task-041, task-043, task-044, task-045

## Goal

Prepare `codemap-mcp@0.7.0` so the merged post-0.6.0 behavior,
performance, and accuracy improvements are ready for npm publication after
review.

## Context

`codemap-mcp@0.6.0` is the current published package. Since that release, main
has gained several package-facing improvements:

- diff-aware `changes_context`
- global `codemap setup`
- generated repo guidance
- compact `query_context` response modes
- persisted BM25 search data and search-ready snapshot caching
- AST-aware TypeScript/JavaScript indexing with exact identifier references

This should ship as a minor release because it adds capabilities while keeping
graph storage compatible and the source index rebuildable.

## Deliverables

- Version bump to `0.7.0`.
- `CHANGELOG.md` added and included in the npm package.
- README updated with a professional latest-release section.
- Generated guidance marker updated for `0.7.0`.
- Release-readiness checks run before opening the release PR.
- Release PR opened against `main`.

## Steps

1. Branch `release-v0.7.0` from `main`.
2. Bump `package.json` to `0.7.0`.
3. Add changelog notes and update README/package files.
4. Regenerate project guidance with the new package version.
5. Run release-readiness checks:
   - `bun run typecheck`
   - `bun test`
   - `bun run build`
   - `git diff --check`
   - `npm pack --dry-run`
   - `npm publish --dry-run --provenance --access public`
   - `npx --yes publint`
   - `npx --yes @arethetypeswrong/cli --pack --ignore-rules cjs-resolves-to-esm`
   - `bun run bin/codemap.ts --version`
   - `bun run bin/codemap.ts init --check`
6. Push the release branch and open the release PR.
7. After merge, publish with `npm publish --access public`.
8. Verify `npm view codemap-mcp version`, reinstall globally with
   `npm i -g codemap-mcp@0.7.0 --prefer-online`, and create the `v0.7.0`
   GitHub release.

## Exit criteria

- [x] Version is bumped to `0.7.0`.
- [x] Changelog and README describe the `0.7.0` release.
- [x] Local release gates pass.
- [x] Release PR is opened.
- [ ] Release PR is merged.
- [ ] `codemap-mcp@0.7.0` is published to npm.
- [ ] Global install reports `codemap --version` as `0.7.0`.
- [ ] GitHub release `v0.7.0` is published.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.

Release-prep verification passed on 2026-05-10: `bun run typecheck`,
`bun test`, `bun run build`, `git diff --check`, `npm pack --dry-run`,
`npm publish --dry-run --provenance --access public`, `npx --yes publint`,
`npx --yes @arethetypeswrong/cli --pack --ignore-rules cjs-resolves-to-esm`,
`bun run bin/codemap.ts --version`, and
`bun run bin/codemap.ts init --check`.

As of release prep, npm latest still resolves to `codemap-mcp@0.6.0`; publish
`0.7.0` only after the release PR is reviewed and merged.

Release PR: https://github.com/AyoubAchour/codemap/pull/41
