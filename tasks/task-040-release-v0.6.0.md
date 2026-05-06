# Task 040: Release v0.6.0

**Status:** in-progress
**Phase:** Phase 4 / release
**Started:** 2026-05-06
**Depends on:** task-035, task-036, task-037, task-038

## Goal

Publish `codemap-mcp@0.6.0` so the merged behavior-consistency work from
tasks 035-038 is available through npm.

## Context

`codemap-mcp@0.5.2` is the current npm latest and GitHub release. Since then,
main has gained several user-facing MCP and CLI capabilities:

- query and source-search match explanations
- source-result diversity
- bounded TS/JS symbol and impact context
- query-time graph memory quality ranking
- read-only workflow writeback suggestions

This should ship as a minor release because it adds capabilities without
changing the persisted graph schema.

## Deliverables

- Version bump to `0.6.0`.
- Generated guidance marker updated for `0.6.0`.
- Handoff, roadmap, and task index updated for release prep.
- Local release gates run before opening the release PR.
- Release PR opened against `main`.

## Steps

1. Branch `release-v0.6.0` from `main`.
2. Bump `package.json` to `0.6.0`.
3. Update release docs and this task file.
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
   `npm i -g codemap-mcp@0.6.0 --prefer-online`, and create the `v0.6.0`
   GitHub release.

## Exit criteria

- [x] Version is bumped to `0.6.0`.
- [x] Release docs describe the `0.6.0` minor release.
- [x] Local release gates pass.
- [ ] Release PR is opened.
- [ ] Release PR is merged.
- [ ] `codemap-mcp@0.6.0` is published to npm.
- [ ] Global install reports `codemap --version` as `0.6.0`.
- [ ] GitHub release `v0.6.0` is published.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.

Release-prep verification passed on 2026-05-06: `bun run typecheck`,
`bun test`, `bun run build`, `git diff --check`, `npm pack --dry-run`,
`npm publish --dry-run --provenance --access public`, `npx --yes publint`,
`npx --yes @arethetypeswrong/cli --pack --ignore-rules cjs-resolves-to-esm`,
`bun run bin/codemap.ts --version`, and
`bun run bin/codemap.ts init --check`.
