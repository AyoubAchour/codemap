# Task 034: Agent Compliance And Onboarding

**Status:** done
**Phase:** Phase 4 / behavior consistency
**Estimate:** 1-2 days
**Depends on:** task-033
**Blocks:** task-035, task-038

## Goal

Make agents use Codemap correctly without relying on chat reminders.

## Context

Competitors such as GitNexus and codebase-memory win part of the experience by
installing agent instructions, hooks, and project guidance aggressively. Codemap
already has `codemap init`, MCP server instructions, and tool descriptions, but
the behavior contract is still too easy for an agent to half-follow:

- query the graph and forget to write back
- use source search as if it were durable memory
- emit nodes for unrelated external research
- skip `graph_health` when old graph anchors look suspicious
- leave stale generated guidance in a repo after package upgrades

This task should strengthen the onboarding path before adding more retrieval
power. Better retrieval is only useful if agents reliably follow the lifecycle.

## Deliverables

- A stricter generated guidance lifecycle from `codemap init`.
- A freshness/check mode that tells the user whether generated guidance is
  missing, stale, or current for the installed Codemap version.
- Client-aware guidance where useful, while keeping one source of truth in
  `src/instructions.ts`.
- Clear post-install/post-init next steps for humans and agents.
- Tests that verify generated guidance includes the codebase-only writeback
  rules, source-index caveats, graph-health usage, and regeneration command.

## Proposed Shape

1. Add a small guidance metadata marker to generated `AGENTS.md` / `CLAUDE.md`
   content, such as Codemap version plus a lifecycle-policy hash.
2. Extend `codemap init` with a non-writing check path, for example:
   `codemap init --check` or `codemap doctor --guidance`.
3. Make the generated guidance more action-oriented:
   - use Codemap only for repo work
   - start with `set_active_topic`
   - prefer `query_context`
   - inspect real files before relying on source hits
   - emit only durable repo-local decisions, invariants, and gotchas
   - use `graph_health` when stale memory appears
   - never write nodes for general web research or unrelated user questions
4. Add tests for both generated content and the freshness check.
5. Dogfood on this repo by regenerating guidance and confirming the file is not
   bloated or internally focused.

## Exit Criteria

- [x] `codemap init` still writes valid guidance by default.
- [x] A user can check whether repo guidance is stale without overwriting it.
- [x] Generated guidance explicitly teaches the current source-index vs graph
      memory boundary.
- [x] Generated guidance explicitly forbids unrelated Q&A, external docs, and
      general research writeback.
- [x] Tests cover fresh, stale, missing, and overwrite guidance paths.
- [x] README/HANDOFF mention the new guidance check.

## Notes

Do not add visual surfaces here. Do not auto-write graph nodes. The point is to
make the existing lifecycle harder to misuse.

Implementation adds versioned generated-guidance metadata, a
`GUIDANCE_POLICY_HASH`, `codemap init --check`, stricter generated Agent
Contract text, README/HANDOFF documentation, and CLI tests for fresh, stale,
missing, partial, and bin-invoked check paths.

Dogfood note: running `bun run bin/codemap.ts --repo . init --check` on this
repo reports `AGENTS.md: stale (missing_metadata)`. That is expected because the
current project guidance predates the metadata marker and contains a
project-specific handoff note. It was not overwritten automatically.
