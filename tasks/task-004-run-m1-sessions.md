# Task 004: Run M1 spike sessions

**Status:** done
**Phase:** Phase 1 — M1 spike
**Estimate:** ~1 week (4–6 sessions × 1–2 hours each, spread across days)
**Depends on:** task-002, task-003
**Blocks:** task-005

## Goal

Run 4–6 sequential Claude Code sessions on the M1 target codebase, all within the chosen subsystem, capturing transcripts and per-session observations. Do not intervene mid-session.

## Context

This is the project's central hypothesis test. Per `ROADMAP.md`: *"if Claude won't keep using the tools when prompted, there is no point building the server."* Each session is real work — a bug fix, small feature, or refactor — drawn from the task ideas in `notes/m1-target.md`.

The sessions are **sequential, not concurrent**, and ideally spread across days. Cross-session memory is part of what we're testing.

## Deliverables

- 4–6 transcripts saved to `m1/transcripts/session-NN.md`.
- An incrementally-populated `m1/graph.json` reflecting nodes accumulated across sessions.
- One filled per-session retro entry per session in `m1/retro-template.md` (or split into per-session files — your preference).

## Steps

For each session 1 through N (4–6 total, run sequentially):

1. **Open a fresh Claude Code session** with the M1 target codebase as the working directory.
2. **Prime Claude with the instruction document.** Either paste `m1/instruction-doc.md` into the conversation, or say: "Read `~/Desktop/Projects/codemap/m1/instruction-doc.md` and follow it for the next task."
3. **Give Claude one task** from the list in `notes/m1-target.md`. State only the task — no hints about the instruction doc.
4. **Let Claude work without intervention.** Do NOT remind it to query, emit, or follow checkpoints. The test is whether it does so on its own. This is the hardest rule. Resist coaching.
5. **When Claude finishes, save the full transcript** to `m1/transcripts/session-NN.md`. Include the user prompts, Claude's responses, and any tool calls / file edits.
6. **Inspect `m1/graph.json`.** Did Claude actually update it? Are the nodes well-formed? Note quality.
7. **Fill the per-session retro entry** in `m1/retro-template.md`:
  - Whether topic was set
  - Query/emit/link counts
  - Kind breakdown of emissions
  - Skipped checkpoints
  - Reminders given (should be 0)
  - Whether Claude re-used prior nodes
8. **Wait at least a few hours** before the next session. (Cross-session memory test.)

After all sessions:

1. Eyeball the cumulative `graph.json`. Is it useful? Or noise?
2. Tally totals across sessions: emissions, knowledge-kind ratio, skip count, re-use count.
3. Move to task-005 for the formal scorecard.

## Exit criteria

- 4–6 transcripts saved in `m1/transcripts/`.
- `m1/graph.json` reflects emissions from across the sessions (not just session 1).
- One per-session retro entry per session, completed.
- Cumulative tallies computed (raw counts; the scorecard against M1 exit criteria comes in task-005).

## Notes

- **If after session 1 Claude is clearly ignoring the instruction doc entirely**, stop. Don't burn 5 more sessions chasing a hypothesis that's already failed. Note this in the retro and skip ahead to task-005 with fewer sessions.
- **Each task should be real work** — fixing an actual bug, building an actual small feature. Contrived "explain how X works" tasks bias the test toward better discipline because they're already aligned with the agent's natural behavior.
- **Resist the temptation to intervene.** If Claude does something dumb mid-session, let it play out. Capture what happened. The product has to work without the user babysitting it; M1 measures the unsupervised baseline.
- **Don't change the instruction doc between sessions.** That's task-005's job (if M1 fails). Changing mid-trial wrecks the comparison.
- Be aware that approval prompts in Claude Code may interrupt the flow. Note which permissions were prompted and how often — this informs the M2 approval-friction risk in `ROADMAP.md` Phase 2.

