# Task 014: `emit_node` tool + per-turn cap enforcement

**Status:** todo
**Phase:** M2 — Sprint 2.2
**Estimate:** 3–4 hours
**Depends on:** task-012 (collision detection), task-013 (MCP server skeleton)
**Blocks:** Sprint 2.3 (CLI + telemetry + npm publish)

## Goal

Wire the fifth and most consequential MCP tool — `emit_node` — into the server. This is where the agent actually writes knowledge into the graph. The tool combines:

- The full V1_SPEC §6.1 Node shape as input.
- Auto-tagging with the active topic (set by `set_active_topic`).
- **Server-side collision detection** via `findCollisions` (from task-012).
- **Per-turn cap enforcement** — max 5 successful emissions between `set_active_topic` calls.
- The `merge_with` and `force_new(reason)` paths per V1_SPEC §7.3.

## Decisions taken (defaults; tell me to change either)

### D1 — Collision response shape: plain success with structured flag, NOT `isError`

**Choice: B (plain).** When collision detection fires, return:

```json
{
  "ok": false,
  "collision": true,
  "candidates": [
    { "id": "payment/checkout", "name": "Checkout flow", "similarity": 0.87 }
  ],
  "next_action": "re-call emit_node with merge_with: <id> OR force_new: true with reason: <string>"
}
```

`isError` is **NOT** set. The collision is a legitimate response asking the agent for a follow-up call, not a protocol error. `isError: true` is reserved for input-validation failures and "couldn't do the work" cases (e.g. NODE_NOT_FOUND on `link`).

Alternative was `isError: true` for collisions; rejected because the agent's instruction document treats this as a flow-control branch, not a failure.

### D2 — `force_new(reason)` storage: prepend to summary

**Choice: prepend.** When the agent resolves a collision via `force_new: { reason: "..." }`, the reason is prepended to the node's summary as `[force_new: <reason>] <original>`. No schema change.

Alternative was a dedicated `force_new_reason?: string` field on the node schema. Rejected for v1 to keep the schema unchanged. If we find we need structured access during M3 we can add the field with a one-line schema patch and a regex migration on existing summaries.

## Context

References:
- `V1_SPEC.md` §7.3 — `emit_node` contract: full input shape, merge semantics, collision response.
- `TECH_SPEC.md` §5 — per-turn cap rules.
- `src/collision.ts` — `findCollisions(incoming, existing, options?)` is what we call.
- `src/graph.ts` — `GraphStore.upsertNode(node, opts)` does the actual write with merge logic.
- `src/tools/_active_topic.ts` — currently holds active-topic state. Per-turn counter goes here too (or sibling).

## Deliverables

- `src/tools/_turn_counter.ts` (or extend `_active_topic.ts`) — module-scoped cap counter, reset on `set_active_topic`.
- `src/tools/emit_node.ts` — the tool registration.
- `src/tools/set_active_topic.ts` (modified) — calls the counter reset.
- `src/index.ts` (modified) — registers emit_node alongside the existing four.
- `test/integration/mcp.test.ts` (extended) — covers all the new behaviors.

## Tool API

```ts
inputSchema: {
  id: NodeIdInput,
  kind: NodeKindSchema,
  name: z.string().min(1),
  summary: z.string(),
  sources: z.array(SourceRefSchema),
  tags: z.array(z.string()).default([]),
  aliases: z.array(z.string()).optional().default([]),
  status: NodeStatusSchema.optional().default("active"),
  confidence: z.number().min(0).max(1),
  last_verified_at: z.iso.datetime(),
  // Collision-resolution flags (mutually exclusive)
  merge_with: z.string().optional(),
  force_new: z.object({ reason: z.string().min(1) }).optional(),
}
```

## Behavior

```
1. If turnCounter >= 5:
     return { ok: false, capped: true,
              message: "5-emission cap reached for this turn. Reset by calling set_active_topic." }
     (no write; turnCounter unchanged)

2. Validate: merge_with and force_new must not both be set.
     If both: return { ok: false, error: "merge_with and force_new are mutually exclusive" }

3. Auto-tag with the active topic (if any).

4. If merge_with is set:
     - resolve target via store.getNode(merge_with); if missing → NODE_NOT_FOUND error.
     - call store.upsertNode(node, { activeTopic, mergeWith: targetId }).
     - skip collision detection.
     - return { ok: true, merged: true, createdId: targetId }.

5. Else (no merge_with):
     candidates = findCollisions(node, store._data().nodes)
     If candidates.length > 0 AND force_new is NOT set:
       return collision response (D1) — no write.
     Else:
       - If force_new is set: prepend "[force_new: <reason>] " to node.summary.
       - call store.upsertNode(node, { activeTopic }).
       - return { ok: true, merged: <merged>, createdId: <id> }.

6. Increment turnCounter on successful write (steps 4 and 5's else branch).
7. await store.save() on every successful write.
```

## Implementation notes

- **Per-turn counter scope:** module-scoped `let emissionsThisTurn = 0;`. Reset on `set_active_topic`. Increment on successful `emit_node`. Counter check happens BEFORE the write.
- **Why no timeout:** purely tied to `set_active_topic` per TECH_SPEC §5. No "5 minutes since last emit" heuristic.
- **structuredContent on every return:** consistent with the other 4 tools. Cast to `Record<string, unknown>` at the boundary.
- **`merge_with` to a missing target:** task-007's GraphStore handles this by creating at the target id. We'd duplicate that error path here as NODE_NOT_FOUND for clarity; optional. Default behavior: trust GraphStore. Decide during implementation.
- **`force_new` summary prefix lifecycle:** the prefix lives in summary forever. If a future emit_node merges into a force_new'd node with a higher confidence, the new summary replaces (per V1_SPEC §7.3 merge), and the force_new audit trail is lost. Acceptable for v1.

## Test plan

- Cap: 5 successful emit_nodes pass; 6th returns capped, no write.
- Cap reset: set_active_topic resets counter; subsequent emit_node accepted.
- Collision: emit a similar node → returns collision response with candidates; no write.
- merge_with: merges into the target id, returns {merged: true}; subsequent get_node confirms merged tags/sources.
- force_new: collision returned; agent re-calls with force_new + reason; node is created; summary prefixed.
- merge_with + force_new together: error response.
- Auto-tag: emitted node has the active topic in its tags.
- Schema validation: bad confidence (>1) → isError.
- Persistence: emitted node round-trips through GraphStore.load().

## Exit criteria

- [ ] All 5 MCP tools register and respond correctly.
- [ ] Per-turn cap enforced; reset on `set_active_topic`.
- [ ] Collision response shape per D1.
- [ ] `force_new` reason stored per D2.
- [ ] All new integration tests pass; ≥80% coverage on `src/tools/emit_node.ts`.
- [ ] `bun build --compile` produces a working binary.
- [ ] CI green.

## Notes

- After this lands, **all 5 V1_SPEC §7 tools are implemented**. Sprint 2.2 is done in spirit; Sprint 2.3 (CLI, telemetry, npm publish) starts next.
- The instruction document in `m1/instruction-doc.md` already references `emit_node` and the collision-resolution flow. Once this lands, the instruction document corresponds 1:1 to runtime behavior.
