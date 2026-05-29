# Task 081: Release v0.10.0

**Status:** done
**Phase:** Phase 4 / release
**Started:** 2026-05-29
**Depends on:** task-080

## Goal

Publish `codemap-mcp@0.10.0` so installed users get broad polyglot source
indexing for mixed-language repositories.

## Context

`codemap-mcp@0.9.2` is the current published release. Task 080 added source
indexing coverage for C, C headers, C++, Java, Gradle, Meson, Go, Rust, Python,
C#, and Kotlin, plus a bundled polyglot benchmark fixture modeled on
scrcpy-class repositories. This should ship as a minor release because it
expands user-facing source discovery behavior without changing graph memory,
capture, or source-index persistence contracts.

## Deliverables

- Version bump to `0.10.0`.
- Changelog and README latest-release notes for `0.10.0`.
- Generated guidance marker updated for `0.10.0`.
- Local release gates run before opening the release PR.
- Release PR opened with verification evidence.
- Package published to npm after merge.
- Published install verified from npm.

## Steps

1. Branch `codex/task-081-release-v0.10.0` from current `main`.
2. Bump `package.json` to `0.10.0`.
3. Update changelog, README, generated guidance, and task files.
4. Run release-readiness checks.
5. Push the release branch and open the release PR.
6. After CI is green, merge the release PR.
7. Publish with `npm publish --access public`.
8. Verify `npm view codemap-mcp version`, reinstall globally with
   `npm i -g codemap-mcp@0.10.0 --prefer-online`, check `codemap --version`,
   run Codex and Claude setup checks, and create the `v0.10.0` GitHub release.

## Exit criteria

- [x] Version is bumped to `0.10.0`.
- [x] Changelog and README describe the `0.10.0` release.
- [x] Generated guidance checks as current for `AGENTS.md` and `CLAUDE.md`.
- [x] Local release gates pass.
- [x] Release PR is opened and CI is green.
- [x] Release PR is merged.
- [x] `codemap-mcp@0.10.0` is published to npm.
- [x] Global install reports `codemap --version` as `0.10.0`.
- [x] GitHub release `v0.10.0` is published.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.

Release-prep verification passed on 2026-05-29:

- `bun run typecheck`
- `bun test` with Bun's real executable directory prepended to `PATH`
  (`520 pass, 0 fail`)
- `bun run build`
- `git diff --check`
- `npm pack --dry-run`
- `npm publish --dry-run --provenance --access public`
- `npx --yes publint`
- `npx --yes @arethetypeswrong/cli --pack . --ignore-rules cjs-resolves-to-esm`
- `bun run bin/codemap.ts --version` (`0.10.0`)
- `npm view codemap-mcp version dist-tags --json --prefer-online` reported
  published `latest` still at `0.9.2`, so `0.10.0` is unpublished before this
  release PR.
- `bun run bin/codemap.ts init --all --check`
- `bun run bin/codemap.ts setup --client codex --capture-hooks --check --repo C:\Users\Admin\Desktop\codemap`
- `bun run bin/codemap.ts setup --client claude --check --repo C:\Users\Admin\Desktop\codemap`
- `bun run bin/codemap.ts benchmark-retrieval --refresh-index if_stale --context-budget-bytes 65000 --response-budget-bytes 65000 --min-file-hit-rate 1 --min-payload-budget-compliance 1`
  passed with primary file hit-rate `1` and payload budget compliance `1`.
- `bun run bin/codemap.ts benchmark-retrieval --profile recall --refresh-index if_stale --response-budget-bytes 65000 --min-file-hit-rate 1 --min-payload-budget-compliance 1 --max-average-response-bytes 65000`
  passed with primary file hit-rate `1`, payload budget compliance `1`, and
  average response bytes below `65000`.
- `scripts/smoke-test.sh`

On local Windows, `scripts/smoke-test.sh` was run through Git Bash with
temporary shims outside the repo for `jq` and Windows npm prefix bin placement;
the package install, CLI version, empty-repo validate, and MCP initialize
handshake all passed.

Release PR #82 opened on 2026-05-29, and GitHub checks passed:

- GitGuardian Security Checks
- `test-bun`
- `test-node`
- `publish-dryrun`

Post-release verification passed on 2026-05-29:

- PR #82 merged into `main` as `Release v0.10.0`.
- `npm publish --access public` published `codemap-mcp@0.10.0`.
- `npm view codemap-mcp version dist-tags --json --prefer-online` reports
  `version: "0.10.0"` and `latest: "0.10.0"`.
- `npm i -g codemap-mcp@0.10.0 --prefer-online` completed successfully.
- Installed `codemap --version` reports `0.10.0`.
- Installed `codemap init --all --check` reports both generated guidance files
  current.
- Installed `codemap setup --client codex --capture-hooks --check --repo C:\Users\Admin\Desktop\codemap`
  reports current MCP config, current capture hooks, and no warnings.
- Installed `codemap setup --client claude --check --repo C:\Users\Admin\Desktop\codemap`
  reports current generated guidance and no warnings.
- `codex mcp get codemap` reports the Codex MCP server enabled with command
  `codemap-mcp`.
- `claude mcp get codemap` reports the local project server connected via
  `codemap-mcp --repo C:\Users\Admin\Desktop\codemap`.
- GitHub release published:
  https://github.com/AyoubAchour/codemap/releases/tag/v0.10.0
