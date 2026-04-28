# Task 012: Implement collision detection (`src/collision.ts`)

**Status:** done — Interpretation B
**Phase:** M2 — Sprint 2.2 (MCP tools + collision detection)
**Estimate:** 3–4 hours (incl. tests)
**Depends on:** task-006 (schemas), task-007 (GraphStore types)
**Blocks:** task-014 (emit_node tool — uses findCollisions)

## Goal

Implement the pure-logic collision detector from `TECH_SPEC.md` §4. When the agent's `emit_node` tool (task-014) is about to create a new node id, this module decides whether the incoming node looks suspiciously similar to an existing one — flagging the collision so the agent can explicitly `merge_with` or `force_new(reason)` per V1_SPEC §7.3.

Stand-alone testable: no I/O, no MCP wiring. Just (incoming, existing-set) → ranked candidates.

## ⚠ Decision required before starting

**The TECH_SPEC §4 algorithm is mathematically ambiguous.** The spec says:

```
score = max(
  name_similarity(incoming.name, N.name)        [weight 0.4],
  name_similarity(incoming.name, alias)         for alias in N.aliases,
  source_overlap(incoming.sources, N.sources)   [weight 0.3],
  tag_overlap(incoming.tags, N.tags)            [weight 0.3],
)
if score >= COLLISION_THRESHOLD (0.65): append candidate
```

Two coherent interpretations of this:

**Interpretation A — `max` of raw similarities, weights are documentation only.** Any single signal ≥ 0.65 fires a collision. Simple, matches spec text literally.

- ✓ Easy to implement and reason about.
- ✗ A shared *tag* alone (e.g. two `auth/`* nodes both tagged `auth`) gives tag_overlap = 1.0 → instant collision. Every node in a busy domain would collide with every other one. That's noise.

**Interpretation B — weighted *sum*, max only over name vs aliases.** The weights actually multiply, the components combine:

```
score = 0.5 * max(name_sim, max_alias_sim) + 0.25 * source_overlap + 0.25 * tag_overlap
```

- ✓ Single weak signals don't fire alone — needs multiple aligned signals.
- ✓ Catches the canonical case in `with-collision-pairs.json`: `messaging/sms-sender` vs `messaging/sms-client` share file path *and* tag *and* have similar names → ≈0.7. Two unrelated `messaging/`* nodes sharing only the tag → ≈0.25. Cleaner separation.
- ✗ Slight rebalance from spec text. Worth a TECH_SPEC §4 patch in this PR.

**My recommendation:** Interpretation B. The M2 collision detector is supposed to flag genuine duplicates, not "any pair of nodes in the same topic." Interpretation A's false-positive behavior would force the agent into constant `force_new` rituals that erode trust in the warning.

**Action requested:** confirm B (or overrule with a different formula) before implementation starts. If B, this task includes a TECH_SPEC §4 patch.

## Context

References:

- `TECH_SPEC.md` §4 — algorithm description (the ambiguous one).
- `V1_SPEC.md` §7.3 — `emit_node` collision response contract (the consumer of this module).
- `fixtures/with-collision-pairs.json` — the regression test target.
- Installed deps: `fastest-levenshtein` (already in package.json) — exports `distance(a, b)` and `closest(str, arr)`. Returns raw edit distance; we'll normalize ourselves.

## Deliverables

- `src/collision.ts` — exports `findCollisions()` plus the helper similarity functions.
- `test/unit/collision.test.ts` — comprehensive unit tests including the with-collision-pairs.json fixture as the canonical positive case.
- (If Interpretation B accepted) `TECH_SPEC.md` §4 update to remove the ambiguous `[weight]` annotations and write the formula explicitly.

## API to implement

```ts
import type { Node, StoredNode } from "./types.js";

export interface CollisionCandidate {
  id: string;
  similarity: number; // [0, 1]
}

export interface CollisionOptions {
  /** Override the env-default threshold. */
  threshold?: number;
  /** Max candidates to return (default 3). */
  limit?: number;
}

/**
 * Find existing nodes that look like duplicates of `incoming`.
 *
 * Pure: no I/O, no globals beyond env-var threshold default.
 * Skips `existing[incoming.id]` (an upsert into the same id is a merge,
 * not a collision).
 *
 * Returns candidates above the threshold, sorted by descending similarity,
 * capped at `limit`. Empty array means no collision.
 */
export function findCollisions(
  incoming: Node,
  existing: Record<string, StoredNode>,
  options?: CollisionOptions,
): CollisionCandidate[];
```

## Implementation notes

### Helper: bigrams + Dice coefficient

```ts
function bigrams(s: string): Set<string> {
  const lower = s.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < lower.length - 1; i++) {
    out.add(lower.slice(i, i + 2));
  }
  return out;
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const aB = bigrams(a);
  const bB = bigrams(b);
  let intersection = 0;
  for (const g of aB) if (bB.has(g)) intersection++;
  return (2 * intersection) / (aB.size + bB.size);
}
```

Dice on bigrams handles short strings well (slugs, names) and is order-insensitive enough to catch reorderings like "Auth middleware" vs "Middleware auth".

### Helper: Jaccard

```ts
function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
```

### Source overlap

```ts
function sourceOverlap(aSrc: SourceRef[], bSrc: SourceRef[]): number {
  if (aSrc.length === 0 || bSrc.length === 0) return 0;
  const aPaths = new Set(aSrc.map((s) => s.file_path));
  const bPaths = new Set(bSrc.map((s) => s.file_path));
  let score = jaccard(aPaths, bPaths);
  // +0.1 bonus if any line ranges overlap on a shared file. Capped at 1.0.
  for (const a of aSrc) {
    for (const b of bSrc) {
      if (
        a.file_path === b.file_path &&
        a.line_range[0] <= b.line_range[1] &&
        b.line_range[0] <= a.line_range[1]
      ) {
        return Math.min(1, score + 0.1);
      }
    }
  }
  return score;
}
```

### Combined score (assuming Interpretation B)

```ts
const COLLISION_THRESHOLD = Number(
  process.env.CODEMAP_COLLISION_THRESHOLD ?? 0.65,
);

export function findCollisions(
  incoming: Node,
  existing: Record<string, StoredNode>,
  options: CollisionOptions = {},
): CollisionCandidate[] {
  const threshold = options.threshold ?? COLLISION_THRESHOLD;
  const limit = options.limit ?? 3;
  const candidates: CollisionCandidate[] = [];

  for (const [id, node] of Object.entries(existing)) {
    if (id === incoming.id) continue;

    const nameSim = diceCoefficient(incoming.name, node.name);
    let aliasSim = 0;
    for (const alias of node.aliases) {
      aliasSim = Math.max(aliasSim, diceCoefficient(incoming.name, alias));
    }
    const nameComponent = Math.max(nameSim, aliasSim);
    const srcComponent = sourceOverlap(incoming.sources, node.sources);
    const tagComponent = jaccard(
      new Set(incoming.tags),
      new Set(node.tags),
    );

    const score =
      0.5 * nameComponent +
      0.25 * srcComponent +
      0.25 * tagComponent;

    if (score >= threshold) {
      candidates.push({ id, similarity: score });
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, limit);
}
```

If you accept Interpretation A instead: replace the `score = ...` with `Math.max(nameComponent, srcComponent, tagComponent)`, drop the `0.5/0.25/0.25` weights.

## Steps

1. **Decide A vs B above.** Required before code is written. If B (recommended), patch `TECH_SPEC.md` §4 to write the formula explicitly and remove the `[weight 0.4]` annotations.
2. Create `src/collision.ts` with the helpers + `findCollisions`. Export everything from the spec API. No I/O.
3. Create `test/unit/collision.test.ts`. At minimum:
  - **Identical name** → score = 1, candidate returned.
  - **Different name + non-overlapping sources/tags** → score < threshold, no candidate.
  - **Same source file** → source_overlap fires (Jaccard 1.0), but if name and tags are different, score should NOT exceed threshold (regression for the false-positive concern).
  - **Same source file + overlapping line ranges** → +0.1 bonus.
  - **Same tag alone** → score < threshold (regression for "shared topic shouldn't trigger").
  - **Name match + tag match** → score crosses threshold.
  - **Alias match** → uses alias name similarity.
  - **Skip self** → `incoming.id === existing.id` → never returned.
  - **Top-N limit** → only `limit` candidates returned, sorted descending.
  - **Threshold override** → option `threshold: 0.4` lowers the bar.
  - **with-collision-pairs.json fixture**: load and run findCollisions for `messaging/sms-sender` vs the rest. Assert `messaging/sms-client` is in the result. Assert unrelated nodes (e.g. `messaging/email-sender`) are NOT.
4. Run `bun test --coverage`. Aim ≥80% line coverage on `src/collision.ts`.
5. If TECH_SPEC §4 was patched in step 1, include the patch in the same PR as the code (single coherent "land collision detection" change).

## Exit criteria

- Decision made on A vs B (and TECH_SPEC §4 patched if needed).
- `src/collision.ts` exports `findCollisions` + helpers.
- All unit tests in `test/unit/collision.test.ts` pass.
- `with-collision-pairs.json` regression test passes (positive case: SMS pair caught; negative case: email-sender NOT flagged for SMS-sender).
- No `any` types.
- Coverage ≥80% on `src/collision.ts`.
- CI green on both `test-bun` and `test-node`.

## Notes

- **Why Dice (not just Levenshtein)?** Dice on character bigrams is order-insensitive ("Auth middleware" ≈ "Middleware auth") and reads well on short slugs. Levenshtein punishes reorderings heavily. We have `fastest-levenshtein` available as a fallback if Dice misclassifies on real data; revisit during M3 if needed.
- **Threshold tuning.** Default 0.65 is the spec's starting guess. Both A and B will need real-world tuning; expose `CODEMAP_COLLISION_THRESHOLD` env var so M2/M3 can tune without redeploys.
- **Don't read graph.json here.** This is a pure function over an in-memory `existing` record. The MCP tool layer (task-014) is responsible for loading the GraphStore and passing `store._data().nodes` (or equivalent public API) in.
- `**forceNew` is task-014's concern, not this one.** The collision detector returns candidates; the tool layer decides what to do based on whether the agent supplied `merge_with` or `force_new`.

