# Task 061: Capture Hook Onboarding

**Status:** done
**Phase:** Phase 4 / onboarding
**Estimate:** 3-5 days
**Depends on:** task-060
**Blocks:** task-062, task-064

## Goal

Make capture setup easy for supported agents, starting with Codex.

## Context

Agentmemory's setup story is stronger because it wires agents through connect
commands, hooks, MCP config, and doctor checks. Codemap already has setup and
generated guidance; the missing piece is capture-hook wiring.

## Deliverables

- Hook setup/check flow for Codex capture events.
- Dry-run and idempotent check behavior.
- Exact manual instructions for unsupported clients.
- Documentation that hooks capture evidence but never write graph memory.

## Steps

1. Decide whether capture setup belongs in `codemap setup` or a new
   `codemap capture-setup` command.
   - Done: capture setup belongs in `codemap setup` behind explicit
     `--capture-hooks` so MCP config and hook config share one health surface.
2. Implement Codex-first hook configuration or generated instructions.
   - Done: Codex writes `~/.codex/codemap/capture-hook.mjs` and merges matching
     entries into `~/.codex/hooks.json`.
3. Add `--check` and dry-run behavior.
   - Done: `--check` reports missing/stale/current without writes, while
     `--dry-run` reports planned writes.
4. Add backup/merge behavior only if the command writes user config.
   - Done: existing Codex hook groups are merged without duplication and stale
     hook files are backed up before update.
5. Update docs and generated guidance after tests exist.
   - Done: README, catch-up spec, task plan, and generated guidance now
     distinguish rebuildable capture evidence from graph memory.

## Exit Criteria

- [x] Running setup twice is idempotent.
- [x] `--check` reports missing or stale hook config without writing.
- [x] Hook scripts call capture commands, not graph write commands.
- [x] Docs distinguish MCP-only use from hook-enabled capture.

## Notes

If client hook APIs are unstable, prefer printing exact commands/config over
silently writing brittle files.
