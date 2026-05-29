# Task 076: Release v0.9.0

**Status:** in-progress
**Phase:** Phase 4 / release
**Started:** 2026-05-29
**Depends on:** task-060, task-061, task-062, task-063, task-064, task-065, task-066, task-067, task-068, task-069, task-070, task-071, task-072, task-073, task-074, task-075

## Goal

Publish `codemap-mcp@0.9.0` so the post-0.8.0 capture, recall, retrieval
quality, benchmark, and setup-hardening work is available through npm.

## Context

`codemap-mcp@0.8.0` is the current npm latest. Since that release, main has
gained several package-facing improvements:

- rebuildable capture summaries and capture audit reports
- capture-summary evidence in compact recall packets
- budget-aware planning and recall context packing
- local-hash semantic retrieval experiments for benchmarks only
- retrieval benchmark guardrails, miss audits, and supporting-file expectations
- bounded source companion context and planning distractor suppression
- hardened MCP setup with explicit repo-root resolution and project-scoped
  Cursor config

This should ship as a minor release because it adds user-facing capabilities
while keeping graph memory local and backward-compatible.

## Deliverables

- Version bump to `0.9.0`.
- Changelog and README latest-release notes for `0.9.0`.
- Generated guidance marker updated for `0.9.0`.
- Release-readiness checks run before opening the release PR.
- Release PR opened against `main`.

## Steps

1. Branch `release-v0.9.0` from `main`.
2. Bump `package.json` to `0.9.0`.
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
   `npm i -g codemap-mcp@0.9.0 --prefer-online`, and create the `v0.9.0`
   GitHub release.

## Exit criteria

- [x] Version is bumped to `0.9.0`.
- [x] Changelog and README describe the `0.9.0` release.
- [x] Local release gates pass.
- [ ] Release PR is opened.
- [ ] Release PR is merged.
- [ ] `codemap-mcp@0.9.0` is published to npm.
- [ ] Global install reports `codemap --version` as `0.9.0`.
- [ ] GitHub release `v0.9.0` is published.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.

Release-prep verification passed on 2026-05-29:

- `bun run typecheck`
- `bun test` (513 pass, 0 fail)
- `bun run build`
- `git diff --check`
- `npm pack --dry-run`
- `npm publish --dry-run --provenance --access public`
- `npx --yes publint`
- `npx --yes @arethetypeswrong/cli --pack . --ignore-rules cjs-resolves-to-esm`
- `bun run bin/codemap.ts --version` (`0.9.0`)
- `bun run bin/codemap.ts init --check`
- `scripts/smoke-test.sh`

On local Windows, `scripts/smoke-test.sh` was run through Git Bash with
temporary shims outside the repo for `jq` and Windows npm prefix bin placement;
the package install, CLI version, empty-repo validate, and MCP initialize
handshake all passed.
