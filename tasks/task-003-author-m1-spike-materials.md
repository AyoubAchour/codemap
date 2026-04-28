# Task 003: Author M1 spike materials

**Status:** done
**Phase:** Phase 1 — M1 spike
**Estimate:** 1–2 hours
**Depends on:** task-002
**Blocks:** task-004

## Goal

Prepare the three artifacts Claude will use during the M1 spike: an instruction document adapted for file-based simulation, a starter `graph.json` matching v1 schema, and a retrospective template for capturing per-turn observations.

## Context

M1 simulates the real MCP server using direct file edits to a fake `graph.json`. No code yet — we're testing whether Claude follows the discipline when prompted. References:

- `V1_SPEC.md` §8 — the instruction document we'll adapt.
- `V1_SPEC.md` §6.3 — the graph file schema.
- `ROADMAP.md` Phase 1 — what M1 measures.

## Deliverables

Inside `~/Desktop/Projects/codemap/m1/`:

- `instruction-doc.md` — the §8 instructions, adapted for file-based simulation.
- `graph.json` — empty starter graph matching V1_SPEC §6.3.
- `retro-template.md` — template for per-session and aggregated observations.
- `transcripts/` — empty folder ready to receive session captures.

## Steps

1. Create the `m1/` folder structure:
  ```bash
   mkdir -p ~/Desktop/Projects/codemap/m1/transcripts
  ```
2. Copy V1_SPEC §8 into `m1/instruction-doc.md` and adapt the references:
  - Replace `query_graph(...)` → "search `m1/graph.json` for nodes matching the task description by tag/text/alias"
  - Replace `emit_node(...)` → "edit `m1/graph.json` to add a node under the `nodes` map; key by `id`"
  - Replace `link(...)` → "edit `m1/graph.json` to add an edge under the `edges` map; key by `from|to|kind`"
  - Replace `set_active_topic(...)` → "edit `m1/graph.json`'s `topics` map and remember the current topic for the rest of this turn"
  - **Keep the 3 enforcement checkpoints verbatim.** They're the load-bearing part.
3. Add a "Collision handling in simulation" section (since there's no server-side detector yet):
  > Before adding a new node id, scan existing nodes for similar names, source-file overlap, or shared tags. If similarity is high, decide explicitly: same concept (merge — extend tags, refresh `last_verified_at`) or genuinely new (write a one-line reason in the node summary).
4. Write the empty starter `m1/graph.json`:
  ```json
   {
     "version": 1,
     "created_at": "<ISO timestamp at creation time>",
     "topics": {},
     "nodes": {},
     "edges": {}
   }
  ```
5. Write `m1/retro-template.md` with two sections:
  **Per-session log** (one entry per session):
   **Aggregate scorecard** (filled at the end, in task-005):

## Exit criteria

- All 4 deliverables exist at the listed paths.
- Instruction doc preserves all 3 enforcement checkpoints from V1_SPEC §8.
- `m1/graph.json` is valid JSON and conforms to V1_SPEC §6.3 (version, topics, nodes, edges keys present).
- Retro template includes explicit checkboxes mapped to the 4 M1 exit criteria.

## Notes

- The simulation isn't a perfect proxy for real MCP. Claude may behave more freely with file edits than with constrained tool calls. Note any drift suspected to come from this in the retro.
- Don't pre-populate the graph. M1 measures the bootstrap path, including the empty-graph starting state.
- Keep `m1/` outside the eventual source code. It's spike material, not production.

