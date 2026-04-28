# Task 010: Unit tests for schema, GraphStore, and validator

**Status:** todo
**Phase:** M2 — Sprint 2.1
**Estimate:** 3–4 hours
**Depends on:** task-006, task-007, task-008, task-009
**Blocks:** Sprint 2.2 (task-011 onwards)

## Goal

Comprehensive unit tests for `src/schema.ts`, `src/graph.ts`, and `src/validator.ts`, achieving ≥80% line coverage on these three modules. Includes the crash-injection test for atomic save and a concurrent-save test for `proper-lockfile`.

## Context

Sprint 2.1 (data layer) ships when these tests are green. Sprint 2.2 (tools + collision detection) builds on top of `GraphStore`, so we lock in the data-layer guarantees before adding more surface area.

References:
- `TECH_SPEC.md` §10 — testing strategy.
- `TECH_SPEC.md` §11 — performance budgets (one perf test against `oversize.json`).
- `ROADMAP.md` Sprint 2.1 — exit criteria.

## Deliverables

- `test/unit/schema.test.ts` — schema parse tests for all fixtures.
- `test/unit/graph.test.ts` — `GraphStore` CRUD, alias resolution, atomic save, lock-protected concurrent save.
- `test/unit/validator.test.ts` — all 4 validator checks against the dedicated fixtures.
- `test/unit/_helpers/crash.ts` — crash-injection helper for the atomic-save test.
- ≥80% line coverage on `src/schema.ts`, `src/graph.ts`, `src/validator.ts` (verified via `bun test --coverage`).
- CI Node-runner test invocation tightened: remove the `|| true` from `task-001`'s ci.yml (it was a placeholder).

## Tests to write

### `schema.test.ts`

For each schema:
- Parse a valid example from the fixture corpus → assert no error, assert defaults applied.
- Parse a malformed example → assert `ZodError` with the right path.

Specifically:
- `NodeSchema` with no `aliases` → resulting object has `aliases: []`.
- `NodeSchema` with no `status` → `status: "active"`.
- `NodeSchema` with `confidence: 1.5` → rejected.
- `EdgeSchema` valid → ok.
- `GraphFileSchema` against `fixtures/small.json` → ok.
- `GraphFileSchema` against `fixtures/malformed-schema.json` → rejected.

### `graph.test.ts`

CRUD:
- `load()` on a nonexistent path creates an empty graph file.
- `load()` on `fixtures/small.json` returns the expected node/edge counts.
- `getNode("auth/middleware")` direct hit.
- `getNode("auth-mw")` resolves via alias on `with-aliases.json`.
- `getNode("nonexistent")` returns `null`.
- `upsertNode` creates a new node when id is fresh.
- `upsertNode` merges when id exists with higher incoming confidence (summary replaced).
- `upsertNode` merges when id exists with lower incoming confidence (summary preserved).
- `upsertNode` with `mergeWith` set: merges into target.
- `ensureEdge` idempotent on duplicate triple (only `note` updates).
- `ensureTopic` idempotent.
- `query("auth")` on `small.json` returns auth-tagged nodes ranked first.
- `save()` round-trip: write, re-load, deep-equal.

Atomic save / crash injection:
- Use `test/unit/_helpers/crash.ts` to spawn a subprocess that begins `save()` then is `SIGKILL`'d after `writeFile` but before `rename`. (Use a debug env flag in `GraphStore.save()` that pauses for 100 ms before rename, gated to test-only.)
- Assert that after the kill: `graph.json` is **either** the previous valid version OR untouched. Never partially written.
- Clean up `graph.json.tmp` if it remains.

Concurrent save:
- Spawn 2 subprocesses that each call `save()` on the same `graph.json`, with different content.
- Both should succeed (the lock serializes them).
- The final file should be a valid graph and match one of the two contents (last-writer-wins is acceptable here; the lock just prevents corruption).

Perf:
- Load `fixtures/oversize.json` (~1k nodes); time `query("auth")`. Assert <100 ms (TECH_SPEC §11 hard limit).

### `validator.test.ts`

- `dangling-edges.json` → `dangling_edge` repairs applied; offending edges removed.
- `alias-collision.json` → `duplicate_alias` warning; nothing repaired.
- `missing-topic.json` → `missing_topic` repair applied; topic now in `topics{}`.
- `malformed-schema.json` → `schema_error`; `ok: false`; load throws.
- `mixed.json` → multiple issues each appear in the expected category (repairs vs warnings).
- `small.json` (clean graph) → `ok: true`, no errors, no repairs.

## Steps

1. Write `test/unit/_helpers/crash.ts`. Pattern:
   ```ts
   import { spawn } from "node:child_process";

   export async function spawnSaveAndKill(args: string[]): Promise<{ exitCode: number; signaled: boolean }> {
     const child = spawn("bun", ["run", "test/unit/_helpers/save-runner.ts", ...args]);
     await new Promise(r => setTimeout(r, 50));  // let it start
     child.kill("SIGKILL");
     return new Promise(resolve => {
       child.on("exit", (code, signal) => resolve({ exitCode: code ?? -1, signaled: signal === "SIGKILL" }));
     });
   }
   ```
   And a sibling `save-runner.ts` that calls `GraphStore.save()` with a debug pause.

2. Write the three test files in this order: `schema.test.ts` → `validator.test.ts` → `graph.test.ts`. (Schema first because it's the simplest; graph last because it has the heaviest infrastructure.)

3. Run locally:
   ```bash
   bun test
   bun test --coverage
   ```
   Coverage report should show ≥80% on the three target modules.

4. Tighten `.github/workflows/ci.yml`:
   - Replace `node --test test/ || true` with `node --test test/` (no `|| true`).
   - Add `bun test` to the Node-runner job too (Bun is available on the runner via `setup-bun@v2`; this gives us the same test results from both runtimes).

5. Push and verify CI is green on both runtimes.

## Exit criteria

- [ ] All three test files exist and pass.
- [ ] Crash-injection test passes (file always valid post-kill).
- [ ] Concurrent-save test passes (no corruption when 2 processes save simultaneously).
- [ ] Perf test on `oversize.json` passes the §11 hard limits.
- [ ] Coverage ≥80% on `src/schema.ts`, `src/graph.ts`, `src/validator.ts`.
- [ ] CI green on both `test-bun` and `test-node` jobs, with `|| true` removed.

## Notes

- **Bun's coverage output:** `bun test --coverage` prints a summary table. Capture it into a CI artifact or just into the job log; no need for fancy reporters in v1.
- **The 100-ms debug pause in `save()`:** gate it on `process.env.NODE_ENV === "test"` AND `process.env.CODEMAP_DEBUG_SLOW_SAVE === "1"`. Belt-and-suspenders so it can never enable in production.
- **`proper-lockfile` on macOS / Linux:** works straight out of the box. On Windows, there are known quirks; if you're on Windows, run this test inside WSL2 (per TECH_SPEC §3.4 cross-platform notes).
- **Don't assert exact node ordering** in `query` results unless the test fixture guarantees a unique ordering. Score ties are stable but hard to prove from outside.
- Coverage gates are advisory in v1. If a critical-path branch is hard to test (e.g. some `proper-lockfile` failure modes), document the gap in a comment rather than chase 100%.
