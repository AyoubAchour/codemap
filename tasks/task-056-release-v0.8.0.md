# Task 056: Release v0.8.0

**Status:** done
**Phase:** Phase 4 / release
**Started:** 2026-05-11
**Depends on:** task-050, task-051, task-052, task-053, task-054, task-055

## Goal

Publish `codemap-mcp@0.8.0` so the post-0.7.0 agentic memory, repo map,
watch, benchmark, and repair workflows are available through npm.

## Context

`codemap-mcp@0.7.0` is the current npm latest. Since that release, main has
gained several package-facing improvements:

- read-only graph anchor repair planning
- source-index-derived repo map and symbol ranking
- optional benchmark-only semantic retrieval and reranking adapters
- source-index watch mode and watcher status
- richer graph memory quality and writeback ordering signals
- a larger retrieval benchmark suite with a non-Codemap fixture repo

This should ship as a minor release because it adds capabilities while keeping
the graph schema backward-compatible and keeping optional semantic providers
disabled by default.

## Deliverables

- Version bump to `0.8.0`.
- Changelog and README latest-release notes for `0.8.0`.
- Generated guidance marker updated for `0.8.0`.
- Release-readiness checks run before opening the release PR.
- Release PR opened against `main`.

## Steps

1. Branch `release-v0.8.0` from `main`.
2. Bump `package.json` to `0.8.0`.
3. Update changelog, README, generated guidance, and this task file.
4. Run release-readiness checks:
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
5. Push the release branch and open the release PR.
6. After merge, publish with `npm publish --access public`.
7. Verify `npm view codemap-mcp version`, reinstall globally with
   `npm i -g codemap-mcp@0.8.0 --prefer-online`, and create the `v0.8.0`
   GitHub release.

## Exit criteria

- [x] Version is bumped to `0.8.0`.
- [x] Changelog and README describe the `0.8.0` release.
- [x] Local release gates pass.
- [x] Release PR is opened.
- [x] Release PR is merged.
- [x] `codemap-mcp@0.8.0` is published to npm.
- [x] Global install reports `codemap --version` as `0.8.0`.
- [x] GitHub release `v0.8.0` is published.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.

Local release gates passed on 2026-05-11:

- `bun run typecheck`
- `bun test` (416 pass, 0 fail)
- `bun run build`
- `git diff --check`
- `npm pack --dry-run`
- `npm publish --dry-run --provenance --access public`
- `npx --yes publint`
- `npx --yes @arethetypeswrong/cli --pack --ignore-rules cjs-resolves-to-esm`
- `bun run bin/codemap.ts --version` (`0.8.0`)
- `bun run bin/codemap.ts init --check`

Release PR: https://github.com/AyoubAchour/codemap/pull/55

Post-merge release verification passed on 2026-05-11:

- PR #55 merged to `main`.
- `npm publish --access public` published `codemap-mcp@0.8.0`.
- `npm view codemap-mcp version dist-tags --json --prefer-online` reports
  `latest` as `0.8.0`.
- `npm i -g codemap-mcp@0.8.0 --prefer-online --registry=https://registry.npmjs.org/`
  completed successfully.
- `codemap --version` reports `0.8.0`.
- `codemap init --check` reports AGENTS.md current for version `0.8.0`.
- GitHub release: https://github.com/AyoubAchour/codemap/releases/tag/v0.8.0
