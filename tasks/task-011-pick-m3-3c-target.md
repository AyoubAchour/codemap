# Task 011: Pick the M3 cross-codebase target (Phase 3c)

**Status:** todo
**Phase:** M3 prep
**Estimate:** 30 min – 1 hour
**Depends on:** task-001 (project setup), task-005 (M1 GO)
**Blocks:** Phase 3c sessions (tasks not yet created)

## Goal

Pick the second codebase that M3 Phase 3c will run against. Per `ROADMAP.md` Phase 3 (3c), this is a different repo than voice2work, ideally TS-stack-similar, that the user knows well enough to judge node quality. Picking now (during M2, not at the start of M3) avoids a last-minute scramble.

## Context

The M1 retrospective flagged single-day / single-user / single-codebase / single-subsystem as a sample limitation (`m1/retrospective.md` §3.4). M3's three-phase split addresses this directly:

- **3a** — same codebase, same subsystem (cross-time test).
- **3b** — same codebase, different subsystem (cross-subsystem test).
- **3c** — different codebase (cross-codebase test). **This task picks the 3c target.**

References:
- `ROADMAP.md` Phase 3 — three-phase M3 structure.
- `m1/retrospective.md` §3.4 (sample limitation) and §6 (next steps).

## Constraints

- **Different codebase than voice2work.** The point is cross-codebase generalization; same repo doesn't test it.
- **TS-stack ideally.** Matches Codemap's own implementation language; future v2 tooling won't trip on stack mismatch. Other typed languages acceptable if no TS option.
- **User must know it well enough to judge node quality.** Ability to say "that emission is right" / "that's a hallucination" is the validation mechanism.
- **NOT an unfamiliar OSS codebase.** That tests onboarding — a v2 problem (Phase 4), not M3.
- **Active enough that 3–4 real-work sessions can happen across days 11–14 of M3.** Recently-merged PRs / active issues = green flag.
- **At least one substantive subsystem with mixed concerns.** Same M1 criterion; need 3–8 logical components in the chosen subsystem so compounding has room to surface.

## Deliverables

- `notes/m3-targets.md` — codebase choice + 3–4 task ideas, structured the same as `notes/m1-target.md`.
- The chosen codebase cloned to a known path (defer the actual clone until just before M3 Phase 3c starts; only need the choice now).

## Steps

1. List candidate repos: your own active personal projects, OSS projects you maintain or have substantively contributed to, work projects you're an admin on.
2. Filter against the constraints above. Drop any that fail.
3. Pick one. Write down: name, GitHub URL, estimated LOC, primary stack, candidate subsystem (3–8 components), rationale.
4. List 3–4 real-work task ideas — bug fixes, features, refactors. Real work, not contrived "explain X" prompts (same M1 standard).
5. Save to `notes/m3-targets.md` with the same structure as `notes/m1-target.md` (Codebase / LOC by area / Subsystem candidates / M3 focus / Task ideas / Why this codebase).

## Exit criteria

- [ ] 3c target codebase identified, GitHub URL captured.
- [ ] Subsystem chosen for 3c (3–8 components, mixed concerns).
- [ ] 3–4 task ideas written down.
- [ ] `notes/m3-targets.md` exists and is gitignored alongside `notes/m1-target.md`.

## Notes

- **This is a prep task, not a blocking one.** Do it any time during M2 (Sprint 2.1 onward). Don't let it block task-006.
- **If no obvious candidate exists, defer 3c.** Better than picking wrong. The 3a + 3b portion of M3 still gives strong cross-time + cross-subsystem signal even without 3c. Document the "no 3c" decision in `notes/m3-targets.md` if that's where you land.
- The path to the cloned 3c repo doesn't need to be `~/Desktop/Projects/<name>/` — anywhere is fine, just record it in the notes.
- If your obvious candidate is another Voice2Work-incorporated project (e.g. mobile), confirm it's distinct enough that calling it "cross-codebase" is honest. A monorepo split into multiple small repos is a borderline case; document the call.
