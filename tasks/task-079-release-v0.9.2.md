# Task 079: Release v0.9.2

**Status:** in-progress
**Phase:** Phase 4 / release
**Started:** 2026-05-29
**Depends on:** task-078

## Goal

Publish `codemap-mcp@0.9.2` so installed users get the Windows setup-check shim
fix from `0.9.1` plus the CRLF-tolerant generated-guidance freshness check.

## Context

`codemap-mcp@0.9.1` was published, but post-publish verification found that a
Windows checkout with CRLF line endings can make `codemap init --check` and
`codemap setup --check` report generated `AGENTS.md` / `CLAUDE.md` files as
stale even when the generated content only differs by line endings.

This should ship as a patch release because it fixes setup verification without
changing graph memory, source index, or capture data formats.

## Deliverables

- Guidance freshness checks normalize CRLF line endings before comparing
  generated guidance content.
- Regression test for CRLF generated guidance.
- Version bump to `0.9.2`.
- Changelog and README latest-release notes for `0.9.2`.
- Generated guidance marker updated for `0.9.2`.
- Local release gates run before opening the release PR.
- Package published to npm after merge.
- Published install verified from npm.

## Steps

1. Branch `codex/release-v0.9.2` from current `main`.
2. Add a failing regression for CRLF generated guidance.
3. Normalize line endings in the generated-guidance freshness checker.
4. Bump `package.json` to `0.9.2`.
5. Update changelog, README, generated guidance, and task files.
6. Run release-readiness checks.
7. Push the release branch and open the release PR.
8. After CI is green, merge the release PR.
9. Publish with `npm publish --access public`.
10. Verify `npm view codemap-mcp version`, reinstall globally with
    `npm i -g codemap-mcp@0.9.2 --prefer-online`, check `codemap --version`,
    run Codex and Claude setup checks, and create the `v0.9.2` GitHub release.

## Exit criteria

- [x] Regression fails before the fix and passes after it.
- [x] Version is bumped to `0.9.2`.
- [x] Changelog and README describe the `0.9.2` release.
- [x] Generated guidance checks as current for `AGENTS.md` and `CLAUDE.md`.
- [x] Local release gates pass.
- [ ] Release PR is opened and CI is green.
- [ ] Release PR is merged.
- [ ] `codemap-mcp@0.9.2` is published to npm.
- [ ] Global install reports `codemap --version` as `0.9.2`.
- [ ] GitHub release `v0.9.2` is published.

## Notes

Use neutral product/task naming for branch, commit, PR, and release text.

Release-prep verification passed on 2026-05-29:

- `bun test test/unit/cli.test.ts -t "--check treats CRLF guidance as current"`
  failed before the fix with exit code `1` and passed after the fix.
- `bun run typecheck`
- `bun test test/unit/cli.test.ts`
- `bun test` with Bun's real executable directory prepended to `PATH`
  (`515 pass, 0 fail`)
- `bun run build`
- `git diff --check`
- `npm pack --dry-run`
- `npm publish --dry-run --provenance --access public`
- `npx --yes publint`
- `npx --yes @arethetypeswrong/cli --pack . --ignore-rules cjs-resolves-to-esm`
- `bun run bin/codemap.ts --version` (`0.9.2`)
- `bun run bin/codemap.ts init --all --check`
- `bun run bin/codemap.ts setup --client codex --capture-hooks --check --repo C:\Users\Admin\Desktop\codemap`
- `bun run bin/codemap.ts setup --client claude --check --repo C:\Users\Admin\Desktop\codemap`
- `scripts/smoke-test.sh`

On local Windows, `scripts/smoke-test.sh` was run through Git Bash with
temporary shims outside the repo for `jq` and Windows npm prefix bin placement;
the package install, CLI version, empty-repo validate, and MCP initialize
handshake all passed.
