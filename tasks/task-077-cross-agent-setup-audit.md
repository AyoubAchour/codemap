# Task 077: Cross-Agent Setup Audit

**Status:** done
**Phase:** Phase 4 / onboarding
**Started:** 2026-05-29
**Depends on:** task-075, task-076

## Goal

Verify Codex and Claude Code can both use Codemap correctly for this checkout:
the MCP server is configured, repo guidance is visible to the agent, and setup
health does not report false missing-command warnings on Windows.

## Context

After `0.9.0`, Codemap's next adoption risk is not another retrieval feature;
it is whether installed agents actually see the right instructions and connect
to the intended repo. A local setup audit found a Windows-specific setup health
bug: `codemap setup --check` used `sh -lc command -v`, so Windows machines
without `sh` reported `codemap-mcp` missing even when npm installed the command
shim.

## Delivered

- Added `CLAUDE.md` generated from the same lifecycle policy as `AGENTS.md`.
- Configured local Claude Code MCP server `codemap` with an explicit
  `--repo C:\Users\Admin\Desktop\codemap` argument.
- Configured Codex global MCP server entry and Codex capture hooks on this
  machine.
- Replaced setup health command lookup with a cross-platform PATH resolver that
  understands Windows `PATHEXT` command shims.
- Added a regression test for command-shim detection on `PATH`.

## Exit Criteria

- [x] Codex setup check reports the MCP server configuration current.
- [x] Codex capture hook check reports current.
- [x] Claude Code reports the `codemap` MCP server connected.
- [x] `AGENTS.md` and `CLAUDE.md` guidance checks report current.
- [x] Windows command-shim setup health regression test passes.
- [x] Full verification gates pass before merging.

## Verification Notes

Local setup verification on 2026-05-29:

- `bun run bin/codemap.ts setup --client codex --capture-hooks --check --repo C:\Users\Admin\Desktop\codemap`
  reports Codex config and capture hooks current.
- `claude mcp get codemap` reports `Status: Connected`, command
  `codemap-mcp`, and args `--repo C:\Users\Admin\Desktop\codemap`.
- `bun run bin/codemap.ts init --claude --check --repo C:\Users\Admin\Desktop\codemap`
  reports both `AGENTS.md` and `CLAUDE.md` current.
