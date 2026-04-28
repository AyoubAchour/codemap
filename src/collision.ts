import type { Node, SourceRef, StoredNode } from "./types.js";

// =============================================================
// Collision detection — TECH_SPEC §4
//
// Pure: no I/O, no globals beyond an env-var threshold default.
// `emit_node` (task-014) wraps GraphStore + this module; when this
// returns candidates, the tool returns a collision response per
// V1_SPEC §7.3 and the agent must re-call with `merge_with` or
// `force_new(reason)`.
// =============================================================

export interface CollisionCandidate {
  id: string;
  /** Combined similarity in [0, 1]. */
  similarity: number;
}

export interface CollisionOptions {
  /** Override the env-default threshold. */
  threshold?: number;
  /** Max candidates to return (default 3). */
  limit?: number;
}

const DEFAULT_THRESHOLD = 0.65;
const DEFAULT_LIMIT = 3;

function envThreshold(): number {
  const raw = process.env.CODEMAP_COLLISION_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD;
}

// =============================================================
// Helpers (exported for unit tests; small enough to inline)
// =============================================================

/**
 * Lowercased character-bigram set of a string.
 * "Auth middleware" → {"au","ut","th","h "," m", ...}
 */
function bigrams(s: string): Set<string> {
  const lower = s.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < lower.length - 1; i++) {
    out.add(lower.slice(i, i + 2));
  }
  return out;
}

/**
 * Sørensen–Dice coefficient on character bigrams. Range [0, 1].
 * Order-insensitive enough to catch reorderings ("Auth middleware" ≈
 * "Middleware auth") and reads well on short strings.
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const aB = bigrams(a);
  const bB = bigrams(b);
  if (aB.size === 0 || bB.size === 0) return 0;
  let intersection = 0;
  for (const g of aB) if (bB.has(g)) intersection++;
  return (2 * intersection) / (aB.size + bB.size);
}

/** Jaccard similarity |A ∩ B| / |A ∪ B|. Empty/empty returns 0. */
function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Jaccard over file_path sets, plus a +0.1 bonus (clamped to 1.0) if any
 * pair of sources shares a file_path AND has overlapping line_ranges.
 */
export function sourceOverlap(
  aSrc: SourceRef[],
  bSrc: SourceRef[],
): number {
  if (aSrc.length === 0 || bSrc.length === 0) return 0;
  const aPaths = new Set(aSrc.map((s) => s.file_path));
  const bPaths = new Set(bSrc.map((s) => s.file_path));
  const base = jaccard(aPaths, bPaths);
  for (const a of aSrc) {
    for (const b of bSrc) {
      if (
        a.file_path === b.file_path &&
        rangesOverlap(a.line_range, b.line_range)
      ) {
        return Math.min(1, base + 0.1);
      }
    }
  }
  return base;
}

/** Jaccard over tag sets. */
export function tagOverlap(aTags: string[], bTags: string[]): number {
  return jaccard(new Set(aTags), new Set(bTags));
}

// =============================================================
// Public: findCollisions
// =============================================================

/**
 * Find existing nodes that look like duplicates of `incoming`.
 *
 * Per TECH_SPEC §4:
 *   score = 0.5 * max(name_sim, max_alias_sim)
 *         + 0.25 * source_overlap
 *         + 0.25 * tag_overlap
 *
 * Returns candidates with score >= threshold, sorted descending,
 * capped at `limit`. Empty array means no collision.
 *
 * Skips `existing[incoming.id]` (an upsert into the same id is a merge,
 * not a collision — that case is handled by GraphStore.upsertNode).
 */
export function findCollisions(
  incoming: Node,
  existing: Record<string, StoredNode>,
  options: CollisionOptions = {},
): CollisionCandidate[] {
  const threshold = options.threshold ?? envThreshold();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const candidates: CollisionCandidate[] = [];

  for (const [id, node] of Object.entries(existing)) {
    if (id === incoming.id) continue;

    const nameSim = diceCoefficient(incoming.name, node.name);
    let aliasSim = 0;
    for (const alias of node.aliases) {
      const s = diceCoefficient(incoming.name, alias);
      if (s > aliasSim) aliasSim = s;
    }
    const nameComponent = Math.max(nameSim, aliasSim);
    const srcComponent = sourceOverlap(incoming.sources, node.sources);
    const tagComponent = tagOverlap(incoming.tags, node.tags);

    const score =
      0.5 * nameComponent + 0.25 * srcComponent + 0.25 * tagComponent;

    if (score >= threshold) {
      candidates.push({ id, similarity: score });
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, limit);
}
