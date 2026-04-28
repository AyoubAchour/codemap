# Task 009: Build fixture corpus

**Status:** in-progress (PR open)
**Phase:** M2 — Sprint 2.1
**Estimate:** 2 hours
**Depends on:** task-006 (need schemas to know what's valid)
**Blocks:** task-010

## Goal

Build 10–15 hand-written `graph.json` fixtures covering the edge cases listed in `TECH_SPEC.md` §10, plus a small README documenting each fixture's purpose.

## Context

Fixtures are the test foundation for `task-010` (unit tests) and any future regression bug. Hand-written fixtures (not generated) document intent: each fixture exists to test a specific behavior.

References:

- `TECH_SPEC.md` §10 — fixture corpus list.
- `V1_SPEC.md` §6 — what valid graphs look like.

## Deliverables

- `fixtures/empty.json` — version-1 graph with no nodes/edges/topics.
- `fixtures/small.json` — 3–5 nodes, 2–3 edges, 1 topic. Realistic content.
- `fixtures/with-aliases.json` — at least 2 nodes with non-empty `aliases`.
- `fixtures/with-collision-pairs.json` — 2 pairs of nodes that should trigger collision detection (similar names, overlapping sources).
- `fixtures/with-deprecated.json` — at least 1 node with `status: "deprecated"`.
- `fixtures/malformed-schema.json` — intentionally invalid (missing required field, wrong type, etc.). Tests reject path.
- `fixtures/dangling-edges.json` — 1+ edges pointing to nonexistent nodes. Tests dangling-edge repair.
- `fixtures/alias-collision.json` — same alias on 2+ nodes. Tests alias-uniqueness warning.
- `fixtures/missing-topic.json` — node tagged with a topic not in `topics{}`. Tests topic auto-fill.
- `fixtures/oversize.json` — programmatically generated, ~1000 nodes. For perf-budget tests.
- `fixtures/knowledge-kinds.json` — covers `decision`, `invariant`, `gotcha` node kinds.
- `fixtures/mixed.json` — combines several issues (deprecated + dangling + alias warning) for integration-style tests.
- `fixtures/README.md` — table of fixture name → purpose → expected validator outcome.

## Steps

1. List the edge cases the validator and tools need to handle. Use `TECH_SPEC.md` §10 as the starting set.
2. For each case, write a minimal fixture that targets it. Use **realistic-looking content** — `auth/middleware`, `payment/stripe-webhook`, not `foo/bar`. Realistic content surfaces real issues; abstract content doesn't.
3. Validate each non-malformed fixture against the schema (parse via `GraphFileSchema` once task-006 is done; write a small one-off script in `fixtures/_check.ts` or similar):
  ```bash
   bun run -e 'import { GraphFileSchema } from "./src/schema.js"; \
     import f from "./fixtures/small.json" with { type: "json" }; \
     console.log(GraphFileSchema.parse(f));'
  ```
   (Or write a one-off script that loops over all fixtures.)
4. Generate `oversize.json` programmatically with a small script (`fixtures/_gen-oversize.ts`):
  - 1000 nodes, mix of kinds, realistic-ish names.
  - 500 edges, valid endpoints.
  - 10 topics.
5. Write `fixtures/README.md`:
  ```markdown
   # Fixtures

   Hand-written `graph.json` fixtures used by unit tests (task-010) and any future regression test.

   | Fixture | Purpose | Expected validator result |
   |---|---|---|
   | empty.json | Empty graph, edge case | ok |
   | small.json | Nominal 3–5 node graph | ok |
   | with-aliases.json | Alias resolution test | ok |
   | with-collision-pairs.json | Trigger collision detection (task-011) | ok |
   | with-deprecated.json | Deprecated node behavior | ok |
   | malformed-schema.json | Invalid; load must reject | schema_error |
   | dangling-edges.json | Dangling edges → dropped | repairs: dangling_edge |
   | alias-collision.json | Same alias on ≥2 nodes | warning: duplicate_alias |
   | missing-topic.json | Tag with no topic entry | repairs: missing_topic |
   | oversize.json | Generated 1k-node graph for perf | ok |
   | knowledge-kinds.json | decision/invariant/gotcha coverage | ok |
   | mixed.json | Multiple issues combined | repairs + warnings |
  ```

## Exit criteria

- At least 10 fixtures committed.
- Each non-`malformed-schema` fixture parses successfully via `GraphFileSchema`.
- `malformed-schema.json` fails parse with a clear error.
- `fixtures/README.md` documents each fixture's name, purpose, and expected validator outcome.
- `oversize.json` is reproducibly generated (script committed; running it produces the same content given the same seed).

## Notes

- **Don't reuse node IDs across fixtures unless intentional.** Independent fixtures avoid spooky test interactions.
- **Time fields in fixtures:** use a fixed ISO timestamp (e.g. `"2026-04-28T00:00:00Z"`) rather than `new Date()` calls. Reproducible fixtures are easier to diff.
- `**content_hash` values:** use `"sha256:0000...0000"` placeholders. Tests don't actually verify hashes against real files; that's the staleness logic, exercised separately.
- The `_gen-oversize.ts` and `_check.ts` scripts are convenience tooling, not test inputs. Keep them in `fixtures/` but underscore-prefixed so it's clear they're not fixtures themselves.

