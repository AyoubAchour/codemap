# Task 061: Capture Hook Onboarding

**Status:** todo
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
2. Implement Codex-first hook configuration or generated instructions.
3. Add `--check` and dry-run behavior.
4. Add backup/merge behavior only if the command writes user config.
5. Update docs and generated guidance after tests exist.

## Exit Criteria

- [ ] Running setup twice is idempotent.
- [ ] `--check` reports missing or stale hook config without writing.
- [ ] Hook scripts call capture commands, not graph write commands.
- [ ] Docs distinguish MCP-only use from hook-enabled capture.

## Notes

If client hook APIs are unstable, prefer printing exact commands/config over
silently writing brittle files.
