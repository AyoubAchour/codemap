# Task 002: Pick the M1 target codebase

**Status:** todo
**Phase:** Phase 0 — Setup
**Estimate:** 30 minutes – 1 hour
**Depends on:** —
**Blocks:** task-003, task-004

## Goal

Pick one specific real codebase to use as the target for the M1 spike (and later M3 trial). Decide which subsystem within it will be the M1 focus. Write down 4–6 task ideas to feed Claude during M1.

This task can be done in parallel with task-001 (project setup); they don't depend on each other.

## Context

Per `ROADMAP.md` Phase 0, we need one chosen codebase before M1 can start. M1 specifically tests within ONE subsystem (auth, payment, etc.), so the codebase needs at least 3–4 distinct subsystems.

Selection criteria (from ROADMAP):

- 5–50k LOC.
- Mixed concerns (auth, db, integrations, payments, etc.).
- A codebase you know well — your own or a familiar one.
- At least 3–8 logical components within the chosen M1 subsystem (smaller = no compounding visible; larger = agent can't form a clean mental map).

## Deliverables

- A chosen codebase, cloned to a known path.
- `notes/m1-target.md` containing: codebase name, path, estimated LOC, list of subsystems, the one subsystem chosen for M1, and 4–6 concrete task ideas.

## Steps

1. List 2–3 candidate codebases (your own active projects or familiar open-source ones).
2. Filter against the criteria above. Drop any that fail.
3. Pick one. Clone it to a known path (e.g. `~/Desktop/Projects/m1-target/`).
4. Skim the structure: list its top-level subsystems.
5. Pick one subsystem with 3–8 logical components for the M1 focus.
6. Write 4–6 task ideas you'd genuinely ask Claude to do within that subsystem — bug fixes, small features, refactors. **Real work**, not contrived exercises.
7. Save the rationale to `~/Desktop/Projects/codemap/notes/m1-target.md`:

```markdown
# M1 Target

## Codebase
- Name: <name>
- Path: <absolute path>
- LOC: ~<estimate>
- Languages: <ts, py, etc>

## Subsystems (top-level)
- subsystem-a — <one-line description>
- subsystem-b — <one-line description>
- ...

## M1 focus
**<chosen subsystem>** — <why this one>. Components: <list 3–8>.

## Task ideas (4–6)
1. <task description, ~1 sentence>
2. ...

## Why this codebase
<2–3 sentences: familiarity, mixed concerns, why it represents a realistic test>
```

## Exit criteria

- Codebase identified and cloned.
- M1 subsystem chosen.
- 4–6 task ideas written down.
- `notes/m1-target.md` exists and is filled in.

## Notes

- **Don't use Codemap itself as the M1 target** — too small, too meta.
- An open-source project you've contributed to is fine if you don't have a personal codebase that fits.
- Avoid a fresh / unfamiliar codebase — M1 measures whether Codemap helps with code you know; if you're learning the code yourself simultaneously, the signal gets noisy.
- Resist picking something glamorous. The point is to surface real friction; that's most likely on a project where you already know where the bodies are buried.

