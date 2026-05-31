# Task 082: Release v0.10.1

**Status:** done
**Phase:** Phase 4 / release
**Started:** 2026-05-31
**Depends on:** task-081

## Goal

Publish `codemap-mcp@0.10.1` so installed users receive the merged post-0.10.0 correctness fixes from PR #83.

## Context

`codemap-mcp@0.10.0` is the current published release. PR #83 merged after the
`0.10.0` release and fixes several correctness issues: stale-snapshot graph
writes could drop independent updates, source anchors accepted out-of-bounds
line ranges, Codex capture hooks were not Windows-safe, captured
`source.command` text was not redacted, capture summaries/recall treated one
malformed JSONL line as a hard failure, setup checks were stricter than the
default init flow, and C++ fallback indexing could mis-classify qualified call
sites as declarations.

This should ship as a patch release because it fixes correctness, setup, and
capture behavior without changing the graph schema, source-index persistence
format, or published CLI surface area.

## Deliverables

- Task/status docs updated for the `0.10.1` patch release.
- Version bump to `0.10.1`.
- Changelog and README latest-release notes for `0.10.1`.
- Generated guidance markers updated for `0.10.1`.
- Local release gates run before opening the release PR.
- Release PR opened with verification evidence.
- Package published to npm after merge.
- Published install verified from npm.

## Steps

1. Branch `release/v0.10.1` from updated `main`.
2. Add task 082 and reconcile stale status docs.
3. Bump `package.json` to `0.10.1`.
4. Update changelog, README, generated guidance, and handoff docs.
5. Run release-readiness checks.
6. Push the release branch and open the release PR.
7. After CI is green, merge the release PR.
8. Publish with `npm publish --access public`.
9. Verify `npm view codemap-mcp version`, reinstall globally with
   `npm i -g codemap-mcp@0.10.1 --prefer-online`, check `codemap --version`,
   run Codex and Claude setup checks, and create the `v0.10.1` GitHub release.

## Exit criteria

- [x] Version is bumped to `0.10.1`.
- [x] Changelog and README describe the `0.10.1` release.
- [x] Generated guidance checks as current for `AGENTS.md` and `CLAUDE.md`.
- [x] Local release gates pass.
- [x] Release PR is opened and CI is green.
- [x] Release PR is merged.
- [x] `codemap-mcp@0.10.1` is published to npm.
- [x] Global install reports `codemap --version` as `0.10.1`.
- [ ] GitHub release `v0.10.1` is published.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.
Keep the patch scope tight: ship only the already-merged correctness fixes from
PR #83 plus the release-bookkeeping updates required to publish them.

Release-prep verification passed on 2026-05-31:

- `bun run typecheck`
- `bun test` (`529 pass, 0 fail`)
- `bun run build`
- `git diff --check`
- `npm pack --dry-run`
- `npm publish --dry-run --provenance --access public`
- `npx --yes publint`
- `npx --yes @arethetypeswrong/cli --pack . --ignore-rules cjs-resolves-to-esm`
- `bun run bin/codemap.ts --version` (`0.10.1`)
- `bun run bin/codemap.ts init --all --check`
- `bun run bin/codemap.ts setup --client codex --capture-hooks --repo C:\Users\Admin\.config\superpowers\worktrees\releases\v0.10.1\codemap`
- `bun run bin/codemap.ts setup --client codex --capture-hooks --check --repo C:\Users\Admin\.config\superpowers\worktrees\releases\v0.10.1\codemap`
- `bun run bin/codemap.ts setup --client claude --check --repo C:\Users\Admin\.config\superpowers\worktrees\releases\v0.10.1\codemap`
- `scripts/smoke-test.sh`

On local Windows, `scripts/smoke-test.sh` was run through Git Bash with
temporary shims outside the repo for `jq` and Windows npm prefix-bin wrappers;
the tarball install, CLI version, empty-repo validate, and MCP initialize
handshake all passed.

- `npm view codemap-mcp version dist-tags --json --prefer-online` still reports
  published `latest` at `0.10.0`, so `0.10.1` is unpublished before this
  release PR.

Post-release verification passed on 2026-05-31:

- PR #84 merged into `main` as `Release v0.10.1`.
- `npm publish --access public` published `codemap-mcp@0.10.1`.
- `npm view codemap-mcp version dist-tags --json --prefer-online` reports
  `version: "0.10.1"` and `latest: "0.10.1"`.
- `npm i -g codemap-mcp@0.10.1 --prefer-online` completed successfully.
- Installed `codemap --version` reports `0.10.1`.
