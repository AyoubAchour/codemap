# Task 008: Implement validator

**Status:** todo
**Phase:** M2 — Sprint 2.1
**Estimate:** 2–3 hours
**Depends on:** task-006, task-007
**Blocks:** task-010

## Goal

Implement the validator from `TECH_SPEC.md` §3.3: schema check, dangling-edge removal, alias-uniqueness warnings, topic-coverage auto-fill. Wire into `GraphStore.load()`.

## Context

The validator's job is two things: (a) refuse to load broken graphs, (b) repair the recoverable issues so the graph stays clean over time even when humans edit `graph.json` by hand.

References:

- `TECH_SPEC.md` §3.3 — validator behavior.
- `V1_SPEC.md` §9 rule 8 — "validator runs on every load."

## Deliverables

- `src/validator.ts` — pure functions exported and called from `GraphStore.load()`.
- A `ValidationResult` type capturing errors, warnings, and applied repairs.
- `GraphStore.load()` wired to run the validator and apply repairs in-memory (persisted on next `save()`).

## API

```ts
export type ValidationIssue =
  | { kind: "schema_error"; message: string }
  | { kind: "dangling_edge"; edgeKey: string; missingEndpoint: string }
  | { kind: "duplicate_alias"; alias: string; nodeIds: string[] }
  | { kind: "missing_topic"; topic: string; nodeId: string };

export type ValidationResult = {
  ok: boolean;          // false only on schema_error
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  repairs: ValidationIssue[];  // issues that were auto-fixed in-memory
};

export function validate(graph: GraphFile): ValidationResult;
export function applyRepairs(graph: GraphFile, result: ValidationResult): GraphFile;
```

## Steps

1. **Schema check** is implicit — already happens in `GraphStore.load()` via `GraphFileSchema.parse()`. If parsing fails, surface it as `{ kind: "schema_error", message }` and `ok: false`. The graph cannot be loaded; CLI exits with code 2; MCP server logs to stderr.
2. **Dangling edges:**
  ```ts
   for (const [key, edge] of Object.entries(graph.edges)) {
     const [from, to] = key.split("|");
     if (!graph.nodes[from]) record({ kind: "dangling_edge", edgeKey: key, missingEndpoint: from });
     if (!graph.nodes[to])   record({ kind: "dangling_edge", edgeKey: key, missingEndpoint: to });
   }
  ```
   Repair: drop the offending edge keys. Record into `repairs`.
3. **Alias uniqueness:**
  - Build a map `alias → nodeId[]`.
  - For aliases appearing on >1 nodeId, emit a warning. Do **not** auto-repair — let the user decide via `codemap correct`.
4. **Topic coverage:**
  - For each node, for each tag, ensure `graph.topics[tag]` exists.
  - If missing, auto-add with `{ created_at: now, autoCreated: true }`. Record into `repairs`.
5. **Wire into `GraphStore.load()`** (modify task-007's implementation):
  - After schema parse: run `validate(data)`.
  - If `result.ok === false`: throw with the schema error.
  - Else: `data = applyRepairs(data, result)`. Store the result for later inspection (e.g. for telemetry).
  - On the **next** `save()`, the repaired graph is persisted.
6. **Add a CLI hook** (deferred to task-018): `codemap validate` runs the validator as a dry-run and prints the report without applying repairs. For now, just expose `validate()` as a pure function so the CLI can wire to it later.

## Exit criteria

- All 4 issue classes are detected.
- Dangling edges are dropped (not just reported).
- Alias collisions surface as warnings, not failures.
- Topic auto-fill works.
- Schema mismatch is a hard failure (no auto-repair attempted).
- Validator runs on every `GraphStore.load()`.
- `ValidationResult` is fully typed; no `any`.

## Notes

- **Don't try to repair schema errors.** Field-by-field migration is real work and easy to get wrong. v1 punts; if the schema breaks, the user runs `codemap validate` (task-018) and fixes by hand.
- **Repair telemetry:** in M2 Sprint 2.3 (telemetry, task-019), record the count of repairs applied during load. Useful M3 signal — if humans are heavily editing `graph.json`, the rate spikes.
- **Order of checks matters slightly.** Run schema first (gating). Then dangling edges (mutates `edges`). Then alias uniqueness (read-only). Then topic coverage (mutates `topics`). Don't reorder.
- **Aliases pointing to a deprecated node** are still valid — don't filter by status.

