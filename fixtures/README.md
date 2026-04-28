# Fixtures

Hand-written `graph.json` fixtures used by the unit test suite (task-010 onward) and any future regression test. Each fixture targets a distinct edge case so failures point cleanly at one behavior.

## Conventions

- **Realistic content.** Names like `auth/middleware`, `payment/stripe-webhook` — not `foo/bar`. Realistic content surfaces real issues; abstract content doesn't.
- **Fixed timestamps:** `2026-04-28T00:00:00Z` everywhere, for reproducible diffs.
- **Placeholder hashes:** `"sha256:0000…0000"`. Tests don't verify hashes; the staleness logic is exercised separately.
- **Don't reuse node IDs across fixtures unless intentional.** Each fixture uses a domain prefix to stay isolated.
- **Underscore-prefixed files (`_*.ts`) are tooling, not fixtures** — don't include them in any fixture-loading loop.

## Fixture inventory

| Fixture | Schema | Validator (repairs / warnings) | Purpose |
|---|---|---|---|
| `empty.json` | ok | 0 / 0 | Edge case: an entirely empty graph (version 1, no topics/nodes/edges). Tests `load()` of a clean store. |
| `small.json` | ok | 0 / 0 | Nominal 3-node, 2-edge graph in the `auth` domain. The default "this graph works fine" baseline. |
| `with-aliases.json` | ok | 0 / 0 | Two `payment/*` nodes with non-empty `aliases`. Tests `getNode()` resolution through aliases. |
| `with-collision-pairs.json` | ok | 0 / 0 | Two pairs of `messaging/*` nodes with similar names + overlapping source files + shared tags, but distinct aliases. Designed for collision-detection tests in Sprint 2.2 (task-013). |
| `with-deprecated.json` | ok | 0 / 0 | A `billing/legacy-invoice` (status: deprecated) replaced by `billing/invoice-v2`. Tests query-time filtering of deprecated nodes and the `replaces` edge kind. |
| `knowledge-kinds.json` | ok | 0 / 0 | Covers all three knowledge kinds (`decision`, `invariant`, `gotcha`) plus `integration`. Tests kind-distribution code paths. |
| `dangling-edges.json` | ok | 4 / 0 | 3 edges with various missing endpoints (one with `to` missing, one with `from` missing, one with both missing — yields 2 reports for the both-missing case). Tests `dangling_edge` repairs in `applyRepairs()`. |
| `alias-collision.json` | ok | 0 / 1 | Two `search/*` nodes share the alias `compose`. Tests `duplicate_alias` warning (no auto-repair). |
| `missing-topic.json` | ok | 2 / 0 | `voice/dialer` is tagged `voice` and `ui` but `topics{}` is empty. Tests `missing_topic` auto-repair (one entry per node × tag combination). |
| `mixed.json` | ok | 3 / 1 | Combines a deprecated node (`legacy-parser`), a duplicate alias (`papa`), missing topics (`duplication`, `ui`), and a dangling edge (`uploader → server-handler`). Integration-style fixture that exercises all 3 validator paths in one load. |
| `oversize.json` | ok | 0 / 0 | Programmatically generated: 1000 nodes, 499 edges, 10 topics. Used by the perf test in task-010 (asserting `query()` < 100 ms per TECH_SPEC §11). Regenerate via `bun run fixtures/_gen-oversize.ts`. |
| `malformed-schema.json` | **reject** | n/a | Intentionally invalid: wrong `version`, malformed `created_at`, `id` containing `\|`, invalid `kind`, empty `name`, negative `line_range`, `confidence > 1`, and an edge with non-enum `kind` (`uses`). Tests that `GraphFileSchema.parse()` rejects all of these failure modes. |

## Tooling

| File | Purpose |
|---|---|
| `_gen-oversize.ts` | Deterministically generates `oversize.json`. Run via `bun run fixtures/_gen-oversize.ts`. Reproducible — same code → byte-identical output. |
| `_check.ts` | Verifies each fixture matches its declared expectation (schema-pass/reject + repair/warning counts). Run via `bun run fixtures/_check.ts`. Exits non-zero on mismatch. Useful sanity check after editing fixtures. |

## How tests should consume fixtures

Generally:

```ts
import smallGraph from "../../fixtures/small.json" with { type: "json" };
import { GraphFileSchema } from "../../src/schema.js";

const parsed = GraphFileSchema.parse(smallGraph);
// ... use `parsed` as a real GraphFile ...
```

Or via `GraphStore.load(repoRoot, { customPath: "fixtures/small.json" })` for scenarios that need the full load path (validator, in-memory repairs, etc.).

For the malformed fixture, expect a thrown error:

```ts
expect(() => GraphFileSchema.parse(malformedGraph)).toThrow();
```
