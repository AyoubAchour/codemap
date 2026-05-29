# Task 078: Release v0.9.1

**Status:** in-progress
**Phase:** Phase 4 / release
**Started:** 2026-05-29
**Depends on:** task-077

## Goal

Publish `codemap-mcp@0.9.1` so installed users get the Windows setup-check fix
from the cross-agent setup audit.

## Context

`codemap-mcp@0.9.0` is the current npm latest. PR #77 merged the
cross-agent setup audit and fixed a Windows-specific health-check failure:
`codemap setup --check` no longer depends on `sh -lc command -v` to find
`codemap-mcp` on `PATH`, so npm command shims are detected correctly on
Windows.

This should ship as a patch release because it fixes setup verification without
changing graph memory, source index, or capture data formats.

## Deliverables

- Version bump to `0.9.1`.
- Changelog and README latest-release notes for `0.9.1`.
- Generated guidance marker updated for `0.9.1`.
- Local release gates run before opening the release PR.
- Release PR opened against `main`.
- Package published to npm after merge.
- Published install verified from npm.

## Steps

1. Branch `codex/release-v0.9.1` from current `main`.
2. Bump `package.json` to `0.9.1`.
3. Update changelog, README, generated guidance, and this task file.
4. Run release-readiness checks:
   - `bun run typecheck`
   - `bun test`
   - `bun run build`
   - `git diff --check`
   - `npm pack --dry-run`
   - `npm publish --dry-run --provenance --access public`
   - `npx --yes publint`
   - `npx --yes @arethetypeswrong/cli --pack . --ignore-rules cjs-resolves-to-esm`
   - `bun run bin/codemap.ts --version`
   - `bun run bin/codemap.ts init --all --check`
   - `bun run bin/codemap.ts setup --client codex --capture-hooks --check --repo C:\Users\Admin\Desktop\codemap`
5. Push the release branch and open the release PR.
6. After CI is green, merge the release PR.
7. Publish with `npm publish --access public`.
8. Verify `npm view codemap-mcp version`, reinstall globally with
   `npm i -g codemap-mcp@0.9.1 --prefer-online`, check `codemap --version`, and
   create the `v0.9.1` GitHub release.

## Exit criteria

- [x] Version is bumped to `0.9.1`.
- [x] Changelog and README describe the `0.9.1` release.
- [x] Generated guidance checks as current for `AGENTS.md` and `CLAUDE.md`.
- [x] Local release gates pass.
- [ ] Release PR is opened and CI is green.
- [ ] Release PR is merged.
- [ ] `codemap-mcp@0.9.1` is published to npm.
- [ ] Global install reports `codemap --version` as `0.9.1`.
- [ ] GitHub release `v0.9.1` is published.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.

Release-prep verification passed on 2026-05-29:

- `bun run typecheck`
- `bun test` (514 pass, 0 fail)
- `bun run build`
- `git diff --check`
- `npm pack --dry-run`
- `npm publish --dry-run --provenance --access public`
- `npx --yes publint`
- `npx --yes @arethetypeswrong/cli --pack . --ignore-rules cjs-resolves-to-esm`
- `bun run bin/codemap.ts --version` (`0.9.1`)
- `bun run bin/codemap.ts init --all --check`
- `bun run bin/codemap.ts setup --client codex --capture-hooks --check --repo C:\Users\Admin\Desktop\codemap`
- `bun run bin/codemap.ts setup --client claude --check --repo C:\Users\Admin\Desktop\codemap`
- `claude mcp get codemap`
- `scripts/smoke-test.sh`

On local Windows, `scripts/smoke-test.sh` was run through Git Bash with
temporary shims outside the repo for `jq` and Windows npm prefix bin placement;
the package install, CLI version, empty-repo validate, and MCP initialize
handshake all passed.
