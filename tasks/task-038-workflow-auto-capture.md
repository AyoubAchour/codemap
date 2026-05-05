# Task 038: Workflow Auto-Capture Suggestions

**Status:** todo
**Phase:** Phase 4 / behavior consistency
**Estimate:** 3-5 days
**Depends on:** task-034, task-036, task-037

## Goal

Help agents notice when they should write back durable knowledge at the end of a
task, without auto-generating graph nodes.

## Context

hilyfux-style memory tooling and GitNexus-like workflows show the value of
capturing what happened during real work. Codemap should borrow the reminder
mechanism, not the automatic write. The graph must stay curated and anchored to
real repo files.

The hard constraint: an MCP server cannot reliably observe every file an agent
reads or edits across all clients. So this task should combine explicit tool
calls, git/worktree inspection, and prior Codemap tool activity into writeback
suggestions.

## Deliverables

- A read-only "capture suggestions" path that proposes possible writeback
  opportunities.
- Suggestions are based on available evidence:
  - active topic
  - Codemap query/source-search activity
  - changed files from git diff
  - optional agent-provided inspected/modified files
  - graph health/staleness signals
- Suggestions never create graph nodes automatically.
- Generated guidance teaches agents to run the capture suggestion step before
  ending repo tasks.

## Proposed Shape

1. Add a read-only MCP/CLI command, for example:
   - `suggest_writeback`
   - `codemap suggest-writeback`
   - or an extension to `query_context`
2. Input can include optional explicit file lists:
   - inspected files
   - modified files
   - summary of work done
3. The server can also inspect `git status` / `git diff --name-only` when a CLI
   path is used. For MCP, prefer explicit input plus existing Codemap session
   state.
4. Output should group suggestions by candidate node kind:
   - decision
   - invariant
   - gotcha
   - relationship/link
5. Each suggestion must include source-anchor candidates and a reminder that
   the agent must inspect real files before calling `emit_node`.

## Exit Criteria

- [ ] Capture suggestions are read-only and never write graph nodes.
- [ ] Suggestions include source-anchor candidates and suggested node kinds.
- [ ] The tool refuses or warns on unrelated/non-repo input.
- [ ] Generated guidance includes an end-of-task writeback suggestion step.
- [ ] Tests cover changed-file suggestions, inspected-file suggestions, and
      no-suggestion cases.
- [ ] Docs state that suggestions are prompts for human/agent judgment, not
      durable memory.

## Notes

This should feel like a helpful nudge at the end of work, not a spam machine.
If suggestions are noisy, the feature fails.
