# Task 033: Release v0.5.1

**Status:** done
**Phase:** Phase 4 / release
**Started:** 2026-05-05
**Depends on:** task-031, task-032

## Goal

Publish `codemap-mcp@0.5.1` so the merged post-0.5.0 CLI polish and public
README cleanup are available through npm.

## Context

Main contained package-facing improvements that were not published while npm
latest remained `0.5.0`:

- `codemap doctor` defaults to compact human output, while `--json` keeps the
  structured tooling response.
- CLI output exits via `process.exitCode` after writing, so large non-zero
  payloads can flush naturally.
- The README and package metadata now present Codemap as public product
  documentation instead of internal project handoff material.

This patch release keeps those polish changes separate from the next behavior
slice and updates the npm README at the same time as the package version.

## Deliverables

- Version bump to `0.5.1`.
- Handoff, roadmap, and task index updated for the patch-release prep.
- Local release gates run before opening the release PR.
- Release PR opened against `main`.

## Steps

1. Branch `release-v0.5.1` from `main`.
2. Bump `package.json` to `0.5.1`.
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
5. Push the release branch and open the release PR.
6. After merge, publish with `npm publish --access public`.
7. Verify `npm view codemap-mcp version`, reinstall globally with
   `npm i -g codemap-mcp@0.5.1 --prefer-online`, and create the `v0.5.1`
   GitHub release.

## Exit criteria

- [x] Version is bumped to `0.5.1`.
- [x] Release docs describe the pending `0.5.1` patch.
- [x] Local release gates pass.
- [x] Release PR is opened.
- [x] Release PR is merged.
- [x] `codemap-mcp@0.5.1` is published to npm.
- [x] Global install reports `codemap --version` as `0.5.1`.
- [x] GitHub release `v0.5.1` is published.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.

Release-prep verification passed on 2026-05-05: `bun run typecheck`,
`bun test`, `bun run build`, `git diff --check`, `npm pack --dry-run`,
`npm publish --dry-run --provenance --access public`, `npx --yes publint`, and
`npx --yes @arethetypeswrong/cli --pack --ignore-rules cjs-resolves-to-esm`.
Release PR: https://github.com/AyoubAchour/codemap/pull/26

Publish verification passed on 2026-05-05: `npm publish --access public`,
`npm view codemap-mcp version dist-tags.latest --json`, global
`npm i -g codemap-mcp@0.5.1 --prefer-online`, `codemap --version`, and GitHub
release `v0.5.1`.
