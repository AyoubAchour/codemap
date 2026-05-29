# Task 075: Agent Setup Hardening

**Status:** done
**Phase:** Phase 4 / onboarding

## Goal

Make Codemap safer to install across MCP clients by reducing the chance that an
agent connects to the wrong repository or sees tools without repo-level usage
guidance.

## Context

`codemap setup` configures access to the MCP server, but access alone does not
teach an agent when to use Codemap. Repo-local guidance from `codemap init`
remains the behavior anchor, especially for clients that drop or hide MCP
`server.instructions`.

The other fragile piece is repo-root selection. The MCP server used to rely only
on `process.cwd()`, which is easy for global client config to get wrong.

## Delivered

- Added explicit MCP repo-root resolution for `codemap-mcp`.
- Added `--repo`, `CODEMAP_REPO_ROOT`, and `CLAUDE_PROJECT_DIR` repo-root paths,
  with cwd as the fallback.
- Added `codemap setup --scope project` for project-scoped setup flows.
- Added repo-local Cursor setup under `.cursor/mcp.json` with
  `args: ["--repo", "${workspaceFolder}"]`.
- Added Claude Code project-scope manual setup guidance.
- Extended setup health to check `CLAUDE.md` when Claude is selected.
- Updated README setup guidance and CLI examples.

## Exit Criteria

- [x] MCP server startup can resolve the repo root without relying only on cwd.
- [x] Claude Code can rely on `CLAUDE_PROJECT_DIR` for local stdio MCP startup.
- [x] Cursor has a project-scoped setup path that binds Codemap to the workspace.
- [x] Setup health reports missing Claude guidance when Claude is selected.
- [x] Existing global setup behavior remains covered by unit tests.
- [x] Focused setup and repo-root tests pass.
