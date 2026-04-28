import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  diceCoefficient,
  findCollisions,
  sourceOverlap,
  tagOverlap,
} from "../../src/collision.js";
import { GraphFileSchema } from "../../src/schema.js";
import type { Node, StoredNode } from "../../src/types.js";

const FIXTURES_DIR = path.resolve(__dirname, "..", "..", "fixtures");

function makeNode(overrides: Partial<Node> & { id: string }): Node {
  return {
    kind: "invariant",
    name: overrides.id,
    summary: "test",
    sources: [
      {
        file_path: "src/test.ts",
        line_range: [1, 10] as [number, number],
        content_hash: "sha256:placeholder",
      },
    ],
    tags: [],
    aliases: [],
    status: "active",
    confidence: 0.9,
    last_verified_at: "2026-04-28T00:00:00Z",
    ...overrides,
  };
}

function asStored(node: Node): StoredNode {
  const { id: _id, ...rest } = node;
  return rest;
}

// =============================================================
// diceCoefficient
// =============================================================

describe("diceCoefficient", () => {
  test("identical strings → 1", () => {
    expect(diceCoefficient("auth/middleware", "auth/middleware")).toBe(1);
  });

  test("completely different strings → 0", () => {
    // Picked to share no bigrams.
    expect(diceCoefficient("abc", "xyz")).toBe(0);
  });

  test("very similar strings → high but < 1", () => {
    const score = diceCoefficient("auth middleware", "auth middlewares");
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThan(1);
  });

  test("case-insensitive", () => {
    expect(diceCoefficient("Auth Middleware", "auth middleware")).toBe(1);
  });

  test("strings shorter than 2 chars → 0", () => {
    expect(diceCoefficient("a", "ab")).toBe(0);
    expect(diceCoefficient("", "abc")).toBe(0);
  });

  test("order-insensitive (different word order, same bigrams)", () => {
    // "auth helper" vs "helper auth" share most bigrams.
    const s = diceCoefficient("auth helper", "helper auth");
    expect(s).toBeGreaterThan(0.4);
  });
});

// =============================================================
// sourceOverlap
// =============================================================

describe("sourceOverlap", () => {
  test("empty arrays → 0", () => {
    expect(sourceOverlap([], [])).toBe(0);
    expect(
      sourceOverlap([], [
        {
          file_path: "x.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
      ]),
    ).toBe(0);
  });

  test("identical file_path sets, non-overlapping ranges → Jaccard only (1.0)", () => {
    const score = sourceOverlap(
      [
        {
          file_path: "x.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
      ],
      [
        {
          file_path: "x.ts",
          line_range: [50, 60],
          content_hash: "sha256:y",
        },
      ],
    );
    expect(score).toBe(1);
  });

  test("identical file + overlapping ranges → capped at 1.0 (no overflow)", () => {
    const score = sourceOverlap(
      [
        {
          file_path: "x.ts",
          line_range: [1, 50],
          content_hash: "sha256:x",
        },
      ],
      [
        {
          file_path: "x.ts",
          line_range: [40, 80],
          content_hash: "sha256:y",
        },
      ],
    );
    // Jaccard 1.0 + 0.1 bonus, clamped to 1.0
    expect(score).toBe(1);
  });

  test("partial path overlap → Jaccard < 1", () => {
    const score = sourceOverlap(
      [
        {
          file_path: "a.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
        {
          file_path: "b.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
      ],
      [
        {
          file_path: "a.ts",
          line_range: [50, 60],
          content_hash: "sha256:x",
        },
        {
          file_path: "c.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
      ],
    );
    // {a,b} ∩ {a,c} = {a} ; union = {a,b,c} ; Jaccard = 1/3
    expect(score).toBeCloseTo(1 / 3, 5);
  });

  test("disjoint paths → 0", () => {
    const score = sourceOverlap(
      [
        {
          file_path: "a.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
      ],
      [
        {
          file_path: "b.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
      ],
    );
    expect(score).toBe(0);
  });
});

// =============================================================
// tagOverlap
// =============================================================

describe("tagOverlap", () => {
  test("empty → 0", () => {
    expect(tagOverlap([], [])).toBe(0);
  });

  test("identical → 1", () => {
    expect(tagOverlap(["auth", "shared"], ["auth", "shared"])).toBe(1);
  });

  test("partial overlap → Jaccard", () => {
    expect(tagOverlap(["a", "b"], ["a", "c"])).toBeCloseTo(1 / 3, 5);
  });
});

// =============================================================
// findCollisions
// =============================================================

describe("findCollisions — basic cases", () => {
  test("identical name + sources + tags → high score, candidate returned", () => {
    const incoming = makeNode({
      id: "auth/incoming",
      name: "Auth middleware",
      tags: ["auth"],
    });
    const existing: Record<string, StoredNode> = {
      "auth/twin": asStored(
        makeNode({
          id: "auth/twin",
          name: "Auth middleware",
          tags: ["auth"],
        }),
      ),
    };
    const candidates = findCollisions(incoming, existing);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe("auth/twin");
    expect(candidates[0]?.similarity).toBeGreaterThanOrEqual(0.65);
  });

  test("different name + non-overlapping sources/tags → no candidate", () => {
    const incoming = makeNode({
      id: "auth/x",
      name: "Auth middleware",
      tags: ["auth"],
      sources: [
        {
          file_path: "src/auth/middleware.ts",
          line_range: [1, 50],
          content_hash: "sha256:x",
        },
      ],
    });
    const existing: Record<string, StoredNode> = {
      "billing/y": asStored(
        makeNode({
          id: "billing/y",
          name: "Stripe charge",
          tags: ["billing"],
          sources: [
            {
              file_path: "src/billing/stripe.ts",
              line_range: [1, 50],
              content_hash: "sha256:y",
            },
          ],
        }),
      ),
    };
    expect(findCollisions(incoming, existing)).toHaveLength(0);
  });
});

describe("findCollisions — single-signal regression cases", () => {
  test("shared TAG alone → score < 0.65 → no candidate", () => {
    // The headline reason for Interpretation B over A. Two unrelated nodes
    // in the same domain (tag = 1.0, nothing else) must not fire.
    const incoming = makeNode({
      id: "auth/aaa",
      name: "Completely different name aaa",
      tags: ["auth"],
      sources: [
        {
          file_path: "src/aaa.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
      ],
    });
    const existing: Record<string, StoredNode> = {
      "auth/zzz": asStored(
        makeNode({
          id: "auth/zzz",
          name: "Something else entirely zzz",
          tags: ["auth"],
          sources: [
            {
              file_path: "src/zzz.ts",
              line_range: [1, 10],
              content_hash: "sha256:y",
            },
          ],
        }),
      ),
    };
    const candidates = findCollisions(incoming, existing);
    expect(candidates).toHaveLength(0);
  });

  test("shared file path alone → score < 0.65 → no candidate", () => {
    const incoming = makeNode({
      id: "x/aaa",
      name: "Completely different name aaa",
      tags: [],
      sources: [
        {
          file_path: "src/shared.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
      ],
    });
    const existing: Record<string, StoredNode> = {
      "y/zzz": asStored(
        makeNode({
          id: "y/zzz",
          name: "Something else entirely zzz",
          tags: [],
          sources: [
            {
              file_path: "src/shared.ts",
              line_range: [50, 60],
              content_hash: "sha256:y",
            },
          ],
        }),
      ),
    };
    const candidates = findCollisions(incoming, existing);
    expect(candidates).toHaveLength(0);
  });

  test("name match + tag match → score crosses threshold", () => {
    const incoming = makeNode({
      id: "auth/incoming",
      name: "Auth middleware",
      tags: ["auth"],
    });
    const existing: Record<string, StoredNode> = {
      "auth/twin": asStored(
        makeNode({
          id: "auth/twin",
          name: "Auth middleware",
          tags: ["auth"],
          sources: [
            {
              file_path: "different.ts",
              line_range: [1, 10],
              content_hash: "sha256:x",
            },
          ],
        }),
      ),
    };
    const candidates = findCollisions(incoming, existing);
    // 0.5 * 1.0 + 0.25 * 0 + 0.25 * 1.0 = 0.75
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.similarity).toBeGreaterThanOrEqual(0.65);
  });
});

describe("findCollisions — alias matching", () => {
  test("incoming name matches an alias on the existing node → counts as name signal", () => {
    const incoming = makeNode({
      id: "auth/incoming",
      name: "JWT validator",
      tags: ["auth"],
    });
    const existing: Record<string, StoredNode> = {
      "auth/jwt": asStored(
        makeNode({
          id: "auth/jwt",
          name: "Token verification helper", // weak similarity to incoming.name
          aliases: ["JWT validator"], // strong alias match
          tags: ["auth"],
        }),
      ),
    };
    const candidates = findCollisions(incoming, existing);
    expect(candidates.map((c) => c.id)).toContain("auth/jwt");
  });
});

describe("findCollisions — semantics", () => {
  test("skips self when incoming.id === existing key", () => {
    const incoming = makeNode({
      id: "auth/x",
      name: "Auth middleware",
      tags: ["auth"],
    });
    const existing: Record<string, StoredNode> = {
      "auth/x": asStored(incoming),
    };
    expect(findCollisions(incoming, existing)).toHaveLength(0);
  });

  test("returns at most `limit` candidates, sorted descending", () => {
    const incoming = makeNode({
      id: "auth/incoming",
      name: "Auth middleware",
      tags: ["auth"],
    });
    const existing: Record<string, StoredNode> = {};
    for (let i = 0; i < 10; i++) {
      existing[`auth/twin-${i}`] = asStored(
        makeNode({
          id: `auth/twin-${i}`,
          name: "Auth middleware",
          tags: ["auth"],
        }),
      );
    }
    const candidates = findCollisions(incoming, existing, { limit: 3 });
    expect(candidates).toHaveLength(3);
    for (let i = 1; i < candidates.length; i++) {
      const prev = candidates[i - 1]?.similarity ?? Number.POSITIVE_INFINITY;
      const cur = candidates[i]?.similarity ?? 0;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });

  test("threshold override lowers the bar", () => {
    // Use distinct sources so only the shared tag fires (score < 0.65).
    const incoming = makeNode({
      id: "auth/aaa",
      name: "completely unrelated alpha",
      tags: ["auth"],
      sources: [
        {
          file_path: "src/aaa.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
      ],
    });
    const existing: Record<string, StoredNode> = {
      "auth/zzz": asStored(
        makeNode({
          id: "auth/zzz",
          name: "totally different omega",
          tags: ["auth"],
          sources: [
            {
              file_path: "src/zzz.ts",
              line_range: [1, 10],
              content_hash: "sha256:y",
            },
          ],
        }),
      ),
    };
    // Default threshold (0.65) → no candidate (only tag overlap fires).
    expect(findCollisions(incoming, existing)).toHaveLength(0);
    // Lower threshold → candidate appears.
    expect(
      findCollisions(incoming, existing, { threshold: 0.2 }),
    ).toHaveLength(1);
  });
});

// =============================================================
// Env-var threshold
// =============================================================

describe("findCollisions — env-var threshold", () => {
  let originalThreshold: string | undefined;
  beforeEach(() => {
    originalThreshold = process.env.CODEMAP_COLLISION_THRESHOLD;
  });
  afterEach(() => {
    if (originalThreshold === undefined) {
      delete process.env.CODEMAP_COLLISION_THRESHOLD;
    } else {
      process.env.CODEMAP_COLLISION_THRESHOLD = originalThreshold;
    }
  });

  test("CODEMAP_COLLISION_THRESHOLD env var lowers the bar", () => {
    process.env.CODEMAP_COLLISION_THRESHOLD = "0.2";
    const incoming = makeNode({
      id: "auth/aaa",
      name: "name AAA",
      tags: ["auth"],
    });
    const existing: Record<string, StoredNode> = {
      "auth/zzz": asStored(
        makeNode({
          id: "auth/zzz",
          name: "name ZZZ",
          tags: ["auth"],
        }),
      ),
    };
    expect(findCollisions(incoming, existing)).toHaveLength(1);
  });

  test("invalid env var falls back to default 0.65", () => {
    process.env.CODEMAP_COLLISION_THRESHOLD = "not-a-number";
    // Distinct sources so only the shared tag fires (score < 0.65 at default).
    const incoming = makeNode({
      id: "auth/aaa",
      name: "completely unrelated alpha",
      tags: ["auth"],
      sources: [
        {
          file_path: "src/aaa.ts",
          line_range: [1, 10],
          content_hash: "sha256:x",
        },
      ],
    });
    const existing: Record<string, StoredNode> = {
      "auth/zzz": asStored(
        makeNode({
          id: "auth/zzz",
          name: "totally different omega",
          tags: ["auth"],
          sources: [
            {
              file_path: "src/zzz.ts",
              line_range: [1, 10],
              content_hash: "sha256:y",
            },
          ],
        }),
      ),
    };
    expect(findCollisions(incoming, existing)).toHaveLength(0);
  });
});

// =============================================================
// Fixture: with-collision-pairs.json (regression for canonical case)
// =============================================================

describe("findCollisions — fixture regression", () => {
  function loadFixture() {
    const raw = JSON.parse(
      readFileSync(
        path.join(FIXTURES_DIR, "with-collision-pairs.json"),
        "utf8",
      ),
    );
    return GraphFileSchema.parse(raw);
  }

  test("messaging/sms-sender flags messaging/sms-client (true positive)", () => {
    const fixture = loadFixture();
    const incomingId = "messaging/sms-sender";
    const incoming: Node = { id: incomingId, ...fixture.nodes[incomingId]! };
    const existing = { ...fixture.nodes };
    delete existing[incomingId];

    const candidates = findCollisions(incoming, existing);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain("messaging/sms-client");
  });

  test("messaging/sms-sender does NOT flag messaging/email-sender (true negative)", () => {
    const fixture = loadFixture();
    const incomingId = "messaging/sms-sender";
    const incoming: Node = { id: incomingId, ...fixture.nodes[incomingId]! };
    const existing = { ...fixture.nodes };
    delete existing[incomingId];

    const candidates = findCollisions(incoming, existing);
    const ids = candidates.map((c) => c.id);
    expect(ids).not.toContain("messaging/email-sender");
  });

  test("messaging/email-sender flags messaging/email-client (mirror case)", () => {
    const fixture = loadFixture();
    const incomingId = "messaging/email-sender";
    const incoming: Node = { id: incomingId, ...fixture.nodes[incomingId]! };
    const existing = { ...fixture.nodes };
    delete existing[incomingId];

    const candidates = findCollisions(incoming, existing);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain("messaging/email-client");
  });
});
