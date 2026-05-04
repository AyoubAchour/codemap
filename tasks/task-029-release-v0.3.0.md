# Task 029: Release v0.3.0

**Status:** in-progress
**Phase:** Phase 4 / release
**Started:** 2026-05-04
**Depends on:** task-027, task-028

## Goal

Publish the behavior-consistency and local source-index work as `codemap-mcp@0.3.0`.

## Context

PR #20 merged the codebase-scoped writeback hardening and local source-index slice, but the package remained at `0.2.2`, which is already the npm latest. This release makes the merged source-index CLI/MCP tools installable through npm.

## Deliverables

- Version bump to `0.3.0`.
- README and handoff release status updated.
- Release recipe corrected to reflect package-driven CLI/MCP versions.
- Local release gates run before opening the release PR.

## Steps

1. Branch `release-v0.3.0` from `main`.
2. Bump `package.json` to `0.3.0`.
3. Update release docs and this task file.
4. Run `bun run typecheck`, `bun test`, `bun run build`, `./scripts/smoke-test.sh`, and `npm publish --dry-run --provenance --access public`.
5. Push the release branch and open the release PR.
6. After merge, publish with `npm publish --access public`.
7. Verify `npm view codemap-mcp version` and reinstall globally with `npm i -g codemap-mcp@0.3.0 --prefer-online`.

## Exit criteria

- [x] Version is bumped to `0.3.0`.
- [x] Release docs describe `0.3.0`.
- [x] Local release gates pass.
- [ ] Release PR is merged.
- [ ] `codemap-mcp@0.3.0` is published to npm.
- [ ] Global install reports `codemap --version` as `0.3.0`.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.
