# Codemap — Tasks

Numbered task files driving execution of the project. Read alongside `V1_SPEC.md`, `TECH_SPEC.md`, and `ROADMAP.md`.

## Naming convention

```
task-NNN-short-slug.md
```

- `**NNN**` — zero-padded 3-digit sequence number, assigned in chronological order of task **creation** (not execution). This keeps file ordering stable in `ls`.
- `**short-slug`** — 2–5 lowercase words separated by hyphens, summarizing the task.

Examples:

- `task-001-project-setup.md`
- `task-014-implement-graph-store.md`
- `task-027-collision-detection-fixtures.md`

When a task is split or superseded, leave the original file in place (mark `cancelled` or `superseded by task-NNN`) — never re-use a number.

## Status values


| Status        | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `todo`        | Not started.                                                                     |
| `in-progress` | Actively being worked on.                                                        |
| `blocked`     | Waiting on an external dependency or decision. **Specify the blocker in Notes.** |
| `done`        | All exit criteria met and verified.                                              |
| `cancelled`   | Abandoned. **Explain why in Notes.**                                             |
| `superseded`  | Replaced by another task. Link to the replacement in Notes.                      |


## File template

Copy this for new tasks:

```markdown
# Task NNN: <Title>

**Status:** todo
**Phase:** Phase 0 / M1 / M2.1 / M2.2 / M2.3 / M3 / Phase 4
**Estimate:** <hours or days>
**Depends on:** task-XXX (if any)
**Blocks:** task-YYY (if any)

## Goal

One sentence: what changes after this task is done.

## Context

Why this matters; references to spec sections (e.g. V1_SPEC §6.1, TECH_SPEC §3.2, ROADMAP Phase 2).

## Deliverables

- Concrete artifact 1
- Concrete artifact 2

## Steps

1. Step 1 (with command if applicable).
2. Step 2.

## Exit criteria

- [ ] Specific testable thing 1
- [ ] Specific testable thing 2

## Notes

Open questions, gotchas, decisions deferred.
```

## Index

Maintained manually. Update status as tasks land.


| #   | Title                                 | Status | Phase           | File                                                                               |
| --- | ------------------------------------- | ------ | --------------- | ---------------------------------------------------------------------------------- |
| 001 | Project setup                         | done   | Phase 0         | [task-001-project-setup.md](task-001-project-setup.md)                             |
| 002 | Pick the M1 target codebase           | done        | Phase 0    | [task-002-pick-m1-target.md](task-002-pick-m1-target.md)                           |
| 003 | Author M1 spike materials             | done   | M1              | [task-003-author-m1-spike-materials.md](task-003-author-m1-spike-materials.md)     |
| 004 | Run M1 spike sessions                 | done   | M1              | [task-004-run-m1-sessions.md](task-004-run-m1-sessions.md)                         |
| 005 | M1 retrospective + GO/NO-GO           | done   | M1              | [task-005-m1-retrospective.md](task-005-m1-retrospective.md)                       |
| 006 | Implement zod schemas                 | done        | M2 / Sprint 2.1 | [task-006-implement-zod-schemas.md](task-006-implement-zod-schemas.md)         |
| 007 | Implement GraphStore class            | done        | M2 / Sprint 2.1 | [task-007-implement-graph-store.md](task-007-implement-graph-store.md)         |
| 008 | Implement validator                   | in-progress | M2 / Sprint 2.1 | [task-008-implement-validator.md](task-008-implement-validator.md)             |
| 009 | Build fixture corpus                  | done        | M2 / Sprint 2.1 | [task-009-build-fixture-corpus.md](task-009-build-fixture-corpus.md)           |
| 010 | Unit tests for schema/store/validator | done        | M2 / Sprint 2.1 | [task-010-graph-store-validator-tests.md](task-010-graph-store-validator-tests.md) |
| 011 | Pick the M3 cross-codebase target (Phase 3c) | todo | M3 prep    | [task-011-pick-m3-3c-target.md](task-011-pick-m3-3c-target.md)                     |
| 012 | Implement collision detection         | done        | M2 / Sprint 2.2 | [task-012-implement-collision-detection.md](task-012-implement-collision-detection.md) |
| 013 | MCP server skeleton + simple tools    | done        | M2 / Sprint 2.2 | [task-013-mcp-server-skeleton.md](task-013-mcp-server-skeleton.md)                 |
| 014 | emit_node tool + per-turn cap         | done        | M2 / Sprint 2.2 | [task-014-emit-node.md](task-014-emit-node.md)                                       |
| 015 | CLI commands (show/correct/deprecate/validate/rollup) | todo (decision required) | M2 / Sprint 2.3 | [task-015-cli.md](task-015-cli.md) |
| 016 | Telemetry (metrics.json) + rollup     | todo (3 decisions required) | M2 / Sprint 2.3 | [task-016-telemetry.md](task-016-telemetry.md)                              |
| 017 | Distribution (README + npm publish + smoke test) | in-progress | M2 / Sprint 2.3 | [task-017-distribution.md](task-017-distribution.md)                                 |


## Conventions

- One task = one PR (when we get to PRs). Easier review, easier rollback.
- If a task balloons past its estimate by 2×, stop and split it.
- Mark `done` only when **all** exit criteria are checked. If something slips, create a follow-up task rather than declare partial done.
- Tasks reference specs by section number, not by quoting them. Specs are the source of truth; tasks describe execution.

