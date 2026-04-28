# Task 005: M1 retrospective + GO/NO-GO decision

**Status:** todo
**Phase:** Phase 1 — M1 spike
**Estimate:** 1–2 hours
**Depends on:** task-004
**Blocks:** task-006 (gated on GO)

## Goal

Synthesize M1 findings against `V1_SPEC.md`'s four success criteria. Make an honest **GO / ITERATE / PAUSE** call. Document the decision with evidence.

## Context

This is the project's hard decision gate. Per `ROADMAP.md` Phase 1:

- **All 4 hold → GO.** Proceed to Sprint 2.1 (task-006).
- **1–2 fail → ITERATE.** Revise the instruction document, re-run M1 with a different subsystem (new tasks, numbered higher).
- **3+ fail → PAUSE.** Rethink whether enforcement-via-prompts is fundamentally insufficient and whether Codemap needs different framing.

## Deliverables

- `m1/retrospective.md` — final retro with aggregated metrics, qualitative observations, and the formal decision.

## Steps

1. **Aggregate the per-session retro entries.** Compute:
  - Total nodes emitted across all sessions.
  - Knowledge-kind ratio: count of (`decision` + `invariant` + `gotcha`) ÷ total emissions.
  - Total skipped checkpoints across all sessions.
  - Number of sessions where Claude explicitly re-used a prior node.
  - Number of reminders given (should be 0).
2. **Score each of the four V1_SPEC §12 / ROADMAP Phase 1 exit criteria** as PASS / FAIL with evidence:

  | #   | Criterion                                           | Pass condition                                        | Evidence             |
  | --- | --------------------------------------------------- | ----------------------------------------------------- | -------------------- |
  | 1   | Re-uses prior nodes by task 4–6                     | At least one explicit re-use in sessions 4–6          |                      |
  | 2   | Maintains 3-checkpoint discipline without reminders | Zero reminders given AND <2 skipped checkpoints total |                      |
  | 3   | Knowledge-kind ratio ≥30%                           | (decision+invariant+gotcha) ÷ total ≥ 0.30            |                      |
  | 4   | No writeback skip by task 2                         | Sessions 1–2 both completed Checkpoint 2 emissions    | <yes/no per session> |

3. **Identify failure modes** that surfaced (even if criteria passed). Examples to look for:
  - Drift after N turns within a session.
  - Hallucinated summaries (Claude wrote a node summary inconsistent with the actual code).
  - Inconsistent ID schemes across sessions.
  - Over-emission (cap would have been hit; we don't have a cap in M1).
  - Under-emission (Claude understood things but didn't write them down).
  - Approval-prompt fatigue (too many prompts disrupted flow).
  - Schema mistakes (Claude wrote malformed JSON).
4. **Make the call.** One of three:
  - **GO** — All 4 criteria PASS. Mark task-006 ready to start.
  - **ITERATE** — 1–2 criteria FAIL. Identify exactly what to change in the instruction document. Open new tasks (task-005a or new numbered tasks) for the re-run.
  - **PAUSE** — 3+ criteria FAIL. Document the failure pattern. Open a new task to re-evaluate the project hypothesis (whether enforcement-via-prompts can work, or whether Codemap needs different framing — e.g. tighter agent integration than MCP allows).
5. **Write `m1/retrospective.md`:**
  ```markdown
   # M1 Retrospective

   **Sessions run:** <N>
   **Date range:** <start> – <end>
   **Target codebase:** <name>
   **M1 subsystem:** <name>

   ## Aggregated metrics
   - Total emissions: <n>
   - Knowledge-kind ratio: <pct>
   - Skipped checkpoints: <n>
   - Reminders given: <n>
   - Sessions with explicit re-use: <n>/<N>

   ## Exit criteria scorecard
   <fill in the table from step 2>

   ## Failure modes observed
   <list per step 3, with transcript citations>

   ## Qualitative observations
   <2–4 paragraphs: what was the experience like? did the graph feel useful by session 4? where did it drift?>

   ## Decision: <GO | ITERATE | PAUSE>

   **Rationale:** <2–3 sentences>

   **If ITERATE:** specific changes to the instruction document, and which subsystem to re-run on.

   **If PAUSE:** what fundamentally needs to change before this project is worth resuming.
  ```
6. **Update task-006's status** based on the decision:
  - GO: leave as `todo`, ready to pick up.
  - ITERATE: mark task-006 `blocked` with note "blocked by M1 ITERATE — see m1/retrospective.md".
  - PAUSE: mark task-006 `blocked` with note "blocked pending M1 re-evaluation".

## Exit criteria

- `m1/retrospective.md` exists and is complete.
- All 4 exit criteria scored with evidence (PASS / FAIL).
- At least 2 specific failure modes named (or "none observed" with reasoning).
- Formal decision recorded.
- task-006's status reflects the decision.

## Notes

- **Be honest.** The point of the gate is catching "this doesn't work" before sinking 2–3 weeks into M2. A "GO with caveats" is not a GO; document caveats explicitly and consider whether they violate the criteria.
- **If ITERATE:** the new tasks for the re-run should be numbered higher than 005 (e.g. task-005a-revise-instruction-doc, task-005b-rerun-m1). Don't reuse 003/004 numbers.
- **If PAUSE:** seriously consider whether Codemap as currently framed (MCP server + prompts) is the right shape. Possible reframings: deeper integration with Claude Code (private API), VS Code extension that owns the agent loop directly, or accepting that the graph is human-curated, not agent-curated.

