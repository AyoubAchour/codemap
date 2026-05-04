# Task 027: Codebase-scoped writeback + visual reset

**Status:** done
**Phase:** Phase 4 / behavior consistency
**Started:** 2026-05-03

## Goal

After this task: Codemap is back to its core product loop. Agents use the MCP graph for repo understanding, but they do not create nodes for arbitrary conversation, external documentation, installs, recommendations, or unrelated research. Active visual/editor extension work is removed until behavior consistency is trustworthy.

## Context

The user clarified two priorities:

- Visual work is delayed until the behavior is consistent.
- The graph's main value is helping future agents understand the current codebase accurately, so node writeback must stay anchored to durable repo-local knowledge.

The current MCP tools are model-controlled, so prompt wording alone is not enough. The server should also reject writes that do not have real repo-file anchors.

## Scope

- Remove the active VS Code visual extension package and root scripts.
- Remove active visual-extension task files and docs that present visual work as the current direction.
- Update lifecycle instructions to explicitly skip Codemap for non-codebase tasks.
- Add runtime validation in `emit_node` so sources must be real repo-relative files.
- Add integration tests for source validation and scoped tool descriptions.

## Out of scope

- Rebuilding any UI, viewer, editor extension, graph canvas, or visual inspector.
- Adding embeddings, hosted APIs, or branch merge UX.
- Enforcing content-hash equality. This task requires real source files; exact hash verification can be a later hardening pass if agent ergonomics allow it.

## Exit criteria

- [x] `packages/vscode` and active VS Code task docs are removed.
- [x] `package.json` no longer exposes VS Code workspace or scripts.
- [x] `src/instructions.ts` and generated agent guidance state codebase-only use clearly.
- [x] `emit_node` rejects empty, absolute, escaping, missing, and URL-like source anchors.
- [x] README, roadmap, handoff, and task index all describe behavior consistency as the current focus.
- [x] `bun run typecheck`
- [x] `bun test`
- [x] `./scripts/smoke-test.sh`
