# Task 039: Release v0.5.2

**Status:** done
**Phase:** Phase 4 / release
**Started:** 2026-05-05
**Depends on:** task-034
**Blocks:** task-035

## Goal

Publish `codemap-mcp@0.5.2` so the merged task-034 agent compliance and
onboarding work is available through npm before starting the next retrieval
slice.

## Context

`codemap-mcp@0.5.1` is the current npm latest and GitHub release. PR #27 merged
the next behavior-facing improvement onto `main` without publishing it:

- generated `AGENTS.md` / `CLAUDE.md` guidance now includes a Codemap version
  and lifecycle-policy hash
- `codemap init --check` can report whether guidance is current, missing, or
  stale without writing files
- the generated Agent Contract is stricter about repo-only Codemap usage,
  source-index results as discovery hints, `graph_health`, and durable
  codebase-only writeback
- review follow-up rejects `--check --force` explicitly and covers
  `policy_hash_mismatch`

This should ship as a patch release because it improves installation and
onboarding behavior without changing the graph schema.

## Deliverables

- Version bump to `0.5.2`.
- Handoff, roadmap, and task index updated for the patch-release prep.
- Local release gates run before opening the release PR.
- Release PR opened against `main`.

## Steps

1. Branch `release-v0.5.2` from `main`.
2. Bump `package.json` to `0.5.2`.
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
   `npm i -g codemap-mcp@0.5.2 --prefer-online`, and create the `v0.5.2`
   GitHub release.

## Exit criteria

- [x] Version is bumped to `0.5.2`.
- [x] Release docs describe the `0.5.2` patch.
- [x] Local release gates pass.
- [x] Release PR is opened.
- [x] Release PR is merged.
- [x] `codemap-mcp@0.5.2` is published to npm.
- [x] Global install reports `codemap --version` as `0.5.2`.
- [x] GitHub release `v0.5.2` is published.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.

Keep this release focused. Task 035 should start after this patch is merged and
published.

Release-prep verification passed on 2026-05-05: `bun run typecheck`,
`bun test`, `bun run build`, `git diff --check`, `npm pack --dry-run`,
`npm publish --dry-run --provenance --access public`, `npx --yes publint`,
`npx --yes @arethetypeswrong/cli --pack --ignore-rules cjs-resolves-to-esm`,
and `bun run bin/codemap.ts --version`.
Release PR: https://github.com/AyoubAchour/codemap/pull/28

Publish verification passed on 2026-05-05: `npm publish --access public`,
`npm view codemap-mcp version dist-tags --json --registry=https://registry.npmjs.org/ --prefer-online`,
global `npm i -g codemap-mcp@0.5.2 --prefer-online --registry=https://registry.npmjs.org/`,
`codemap --version`, `codemap init --help`, `codemap init --check --force`,
and GitHub release `v0.5.2`.
