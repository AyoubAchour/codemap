# Task 006: Implement zod schemas

**Status:** in-progress (PR open)
**Phase:** M2 — Sprint 2.1 (Core data layer)
**Estimate:** 2–3 hours
**Depends on:** task-001 (project scaffold), task-005 (M1 GO)
**Blocks:** task-007, task-008, task-009, task-010

## Goal

Implement the zod schemas from `TECH_SPEC.md` §3.1 in `src/schema.ts`, plus derived TS types in `src/types.ts`. Add a smoke test that parses valid and invalid inputs.

## Context

Schemas are the foundation. Every other module — graph store, validator, MCP tools — depends on them. Get them right first; they're cheap to change now, expensive once tools are written against them.

References:

- `TECH_SPEC.md` §3.1 — schema definitions (verbatim).
- `V1_SPEC.md` §6 — the data model these schemas implement.

## Deliverables

- `src/schema.ts` — zod schemas: `SourceRefSchema`, `NodeKindSchema`, `NodeSchema`, `EdgeKindSchema`, `EdgeSchema`, `GraphFileSchema`.
- `src/types.ts` — `z.infer` types for `Node`, `Edge`, `GraphFile`, `NodeKind`, `EdgeKind`, `SourceRef`.
- `test/unit/schema.test.ts` — smoke tests on a valid object and a malformed one for each schema.

## Steps

1. Create `src/schema.ts`. Copy the schemas from `TECH_SPEC.md` §3.1 verbatim. Note the gotchas:
  - `aliases` defaults to `[]`.
  - `status` defaults to `"active"`.
  - `confidence` is bounded `[0, 1]`.
  - `last_verified_at` uses `.datetime()` (ISO-8601).
  - Edge map keys are `"from|to|kind"` strings (not enforced in schema; convention).
2. Create `src/types.ts`:
  ```ts
   import type { z } from "zod";
   import type {
     SourceRefSchema, NodeKindSchema, NodeSchema,
     EdgeKindSchema, EdgeSchema, GraphFileSchema,
   } from "./schema.js";

   export type SourceRef = z.infer<typeof SourceRefSchema>;
   export type NodeKind = z.infer<typeof NodeKindSchema>;
   export type Node = z.infer<typeof NodeSchema>;
   export type EdgeKind = z.infer<typeof EdgeKindSchema>;
   export type Edge = z.infer<typeof EdgeSchema>;
   export type GraphFile = z.infer<typeof GraphFileSchema>;
  ```
3. Add a small key-builder helper in `src/schema.ts` for edge keys:
  ```ts
   export function edgeKey(from: string, to: string, kind: EdgeKind): string {
     return `${from}|${to}|${kind}`;
   }
  ```
4. Create `test/unit/schema.test.ts`:
  - For each schema, test parsing one valid example and one invalid example.
  - Use realistic content (`auth/middleware`, not `foo/bar`).
  - Assert that defaults are applied (parsing a Node without `aliases` produces `aliases: []`).
5. Run locally:
  ```bash
   bun run typecheck
   bun test
  ```
   Both must pass.

## Exit criteria

- `src/schema.ts` exports all 6 schemas + `edgeKey` helper.
- `src/types.ts` exports all 6 z.infer types.
- No `any` types in either file.
- Defaults applied correctly when parsing minimal objects (verify in tests).
- All schema tests pass on Bun and Node 22+ in CI.
- `bun run typecheck` exits 0.

## Notes

- **Don't add custom refinements yet** (e.g. "id format must be `domain/name`"). Format constraints belong in the validator (task-008) or are agent discipline (instruction doc), not in the schema. Schema validation should be cheap and uncontroversial.
- **Don't import schemas in `src/types.ts`** — only import the schema *types* via `import type`. Keeps `types.ts` zero-runtime-cost.
- If you need a JSON Schema export for the MCP tool definitions later (M2 Sprint 2.2), zod has `zod-to-json-schema` — add it then, not now.
- Follow up: in M2 Sprint 2.2, consider tightening with `.brand<"NodeId">()` for ID strings to prevent accidentally passing edge keys where node IDs are expected. Defer for now to keep zod use plain.

