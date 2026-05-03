import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  EdgeKindSchema,
  EdgeSchema,
  edgeKey,
  GraphFileSchema,
  NodeIdSchema,
  NodeKindSchema,
  NodeSchema,
  NodeStatusSchema,
  parseEdgeKey,
  SourceRefSchema,
  TopicSchema,
} from "../../src/schema.js";

const FIXTURES_DIR = path.resolve(__dirname, "..", "..", "fixtures");
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

// =============================================================
// SourceRef
// =============================================================

describe("SourceRefSchema", () => {
  test("parses a valid source ref", () => {
    const valid = {
      file_path: "src/_features/auth/auth.schemas.ts",
      line_range: [1, 80] as [number, number],
      content_hash: "sha256:abc123",
    };
    expect(() => SourceRefSchema.parse(valid)).not.toThrow();
  });

  test("rejects content_hash without sha256: prefix", () => {
    const invalid = {
      file_path: "src/auth.ts",
      line_range: [1, 10] as [number, number],
      content_hash: "abc123",
    };
    expect(() => SourceRefSchema.parse(invalid)).toThrow();
  });

  test("rejects line_range with negative numbers", () => {
    expect(() =>
      SourceRefSchema.parse({
        file_path: "x.ts",
        line_range: [-1, 10] as [number, number],
        content_hash: "sha256:x",
      }),
    ).toThrow();
  });

  test("rejects line_range with floats", () => {
    expect(() =>
      SourceRefSchema.parse({
        file_path: "x.ts",
        line_range: [1.5, 10] as [number, number],
        content_hash: "sha256:x",
      }),
    ).toThrow();
  });

  test("rejects line_range with zero (1-indexed lines)", () => {
    expect(() =>
      SourceRefSchema.parse({
        file_path: "x.ts",
        line_range: [0, 10] as [number, number],
        content_hash: "sha256:x",
      }),
    ).toThrow();
  });

  test("rejects line_range with start > end (inverted)", () => {
    expect(() =>
      SourceRefSchema.parse({
        file_path: "x.ts",
        line_range: [50, 10] as [number, number],
        content_hash: "sha256:x",
      }),
    ).toThrow();
  });

  test("accepts equal start and end (single-line range)", () => {
    expect(() =>
      SourceRefSchema.parse({
        file_path: "x.ts",
        line_range: [42, 42] as [number, number],
        content_hash: "sha256:x",
      }),
    ).not.toThrow();
  });
});

// =============================================================
// NodeKind & NodeStatus
// =============================================================

describe("NodeKindSchema", () => {
  test("accepts all 9 valid kinds", () => {
    for (const kind of [
      "file",
      "symbol",
      "package",
      "integration",
      "concept",
      "flow",
      "decision",
      "invariant",
      "gotcha",
    ]) {
      expect(() => NodeKindSchema.parse(kind)).not.toThrow();
    }
  });

  test("rejects unknown kinds", () => {
    expect(() => NodeKindSchema.parse("module")).toThrow();
    expect(() => NodeKindSchema.parse("class")).toThrow();
  });
});

describe("NodeStatusSchema", () => {
  test("accepts active and deprecated", () => {
    expect(() => NodeStatusSchema.parse("active")).not.toThrow();
    expect(() => NodeStatusSchema.parse("deprecated")).not.toThrow();
  });

  test("rejects other values", () => {
    expect(() => NodeStatusSchema.parse("removed")).toThrow();
  });
});

// =============================================================
// Node
// =============================================================

describe("NodeSchema", () => {
  const baseValid = {
    id: "auth/middleware",
    kind: "invariant" as const,
    name: "Auth Middleware",
    summary: "Validates session cookies on every request.",
    sources: [
      {
        file_path: "src/auth/middleware.ts",
        line_range: [1, 80] as [number, number],
        content_hash: "sha256:placeholder",
      },
    ],
    tags: ["auth", "shared"],
    confidence: 0.9,
    last_verified_at: "2026-04-28T15:30:00Z",
  };

  test("parses a minimal valid node", () => {
    expect(() => NodeSchema.parse(baseValid)).not.toThrow();
  });

  test("applies default for missing aliases (empty array)", () => {
    const parsed = NodeSchema.parse(baseValid);
    expect(parsed.aliases).toEqual([]);
  });

  test("applies default for missing status (active)", () => {
    const parsed = NodeSchema.parse(baseValid);
    expect(parsed.status).toBe("active");
  });

  test("preserves explicit aliases when provided", () => {
    const parsed = NodeSchema.parse({
      ...baseValid,
      aliases: ["AuthMW", "middleware/auth"],
    });
    expect(parsed.aliases).toEqual(["AuthMW", "middleware/auth"]);
  });

  test("rejects confidence > 1", () => {
    expect(() => NodeSchema.parse({ ...baseValid, confidence: 1.5 })).toThrow();
  });

  test("rejects confidence < 0", () => {
    expect(() =>
      NodeSchema.parse({ ...baseValid, confidence: -0.1 }),
    ).toThrow();
  });

  test("rejects empty id", () => {
    expect(() => NodeSchema.parse({ ...baseValid, id: "" })).toThrow();
  });

  test("rejects id containing '|' (reserved as edge-key separator)", () => {
    expect(() =>
      NodeSchema.parse({ ...baseValid, id: "auth|middleware" }),
    ).toThrow();
  });

  test("rejects empty name", () => {
    expect(() => NodeSchema.parse({ ...baseValid, name: "" })).toThrow();
  });

  test("rejects malformed last_verified_at (not ISO-8601)", () => {
    expect(() =>
      NodeSchema.parse({ ...baseValid, last_verified_at: "yesterday" }),
    ).toThrow();
  });
});

describe("NodeIdSchema", () => {
  test("accepts non-empty node ids without edge separators", () => {
    expect(() => NodeIdSchema.parse("auth/middleware")).not.toThrow();
  });

  test("rejects empty ids and ids containing '|'", () => {
    expect(() => NodeIdSchema.parse("")).toThrow();
    expect(() => NodeIdSchema.parse("auth|middleware")).toThrow();
  });
});

// =============================================================
// EdgeKind & Edge
// =============================================================

describe("EdgeKindSchema", () => {
  test("accepts all 8 valid kinds (incl. widened derived_from + mirrors)", () => {
    for (const kind of [
      "imports",
      "calls",
      "depends_on",
      "implements",
      "replaces",
      "contradicts",
      "derived_from",
      "mirrors",
    ]) {
      expect(() => EdgeKindSchema.parse(kind)).not.toThrow();
    }
  });

  test("rejects pre-tightening invented kinds", () => {
    // These are the kinds Claude reached for in M1 sessions 1–2 before
    // the prompt was tightened. Keep this assertion to prevent regressions.
    for (const kind of [
      "derived-from",
      "uses",
      "sibling-pattern",
      "relates_to",
    ]) {
      expect(() => EdgeKindSchema.parse(kind)).toThrow();
    }
  });
});

describe("EdgeSchema", () => {
  test("parses a valid edge with note", () => {
    const valid = {
      from: "auth/middleware",
      to: "auth/jwt",
      kind: "depends_on" as const,
      note: "session validation depends on JWT shape",
    };
    expect(() => EdgeSchema.parse(valid)).not.toThrow();
  });

  test("parses a valid edge without note (optional)", () => {
    const valid = {
      from: "auth/middleware",
      to: "auth/jwt",
      kind: "imports" as const,
    };
    expect(() => EdgeSchema.parse(valid)).not.toThrow();
  });

  test("rejects edge with invalid kind", () => {
    expect(() =>
      EdgeSchema.parse({
        from: "a",
        to: "b",
        kind: "uses",
      }),
    ).toThrow();
  });

  test("rejects edge with empty from", () => {
    expect(() =>
      EdgeSchema.parse({
        from: "",
        to: "b",
        kind: "depends_on",
      }),
    ).toThrow();
  });

  test("rejects edge with empty to", () => {
    expect(() =>
      EdgeSchema.parse({
        from: "a",
        to: "",
        kind: "depends_on",
      }),
    ).toThrow();
  });

  test("rejects edge with from containing '|'", () => {
    expect(() =>
      EdgeSchema.parse({
        from: "a|b",
        to: "c",
        kind: "depends_on",
      }),
    ).toThrow();
  });
});

// =============================================================
// Topic
// =============================================================

describe("TopicSchema", () => {
  test("parses a valid topic", () => {
    const valid = {
      created_at: "2026-04-28T15:30:00Z",
      auto_created: true,
    };
    expect(() => TopicSchema.parse(valid)).not.toThrow();
  });

  test("rejects missing auto_created", () => {
    expect(() =>
      TopicSchema.parse({ created_at: "2026-04-28T15:30:00Z" }),
    ).toThrow();
  });
});

// =============================================================
// GraphFile
// =============================================================

describe("GraphFileSchema", () => {
  test("parses an empty graph (version 1)", () => {
    const valid = {
      version: 1 as const,
      created_at: "2026-04-28T15:30:00Z",
      topics: {},
      nodes: {},
      edges: {},
    };
    expect(() => GraphFileSchema.parse(valid)).not.toThrow();
  });

  test("parses a populated graph", () => {
    const valid = {
      version: 1 as const,
      created_at: "2026-04-28T15:30:00Z",
      topics: {
        auth: { created_at: "2026-04-28T15:30:00Z", auto_created: true },
      },
      nodes: {
        "auth/middleware": {
          kind: "invariant" as const,
          name: "Auth middleware",
          summary: "Validates session.",
          sources: [
            {
              file_path: "src/auth/middleware.ts",
              line_range: [1, 80] as [number, number],
              content_hash: "sha256:abc",
            },
          ],
          tags: ["auth"],
          aliases: [],
          status: "active" as const,
          confidence: 0.9,
          last_verified_at: "2026-04-28T15:30:00Z",
        },
      },
      edges: {
        "auth/middleware|auth/jwt|depends_on": {
          note: "uses JWT shape",
        },
      },
    };
    expect(() => GraphFileSchema.parse(valid)).not.toThrow();
  });

  test("rejects wrong version", () => {
    expect(() =>
      GraphFileSchema.parse({
        version: 2,
        created_at: "2026-04-28T15:30:00Z",
        topics: {},
        nodes: {},
        edges: {},
      }),
    ).toThrow();
  });

  test("rejects missing required top-level field", () => {
    expect(() =>
      GraphFileSchema.parse({
        version: 1,
        // missing created_at
        topics: {},
        nodes: {},
        edges: {},
      }),
    ).toThrow();
  });

  test("rejects edge key with invalid kind in third segment", () => {
    // Regression for V1_SPEC §9.8: schema check on every load must catch
    // pre-tightening invented edge kinds (e.g. `uses`) that may be embedded
    // in stored edge keys, not just in EdgeSchema.kind values.
    expect(() =>
      GraphFileSchema.parse({
        version: 1,
        created_at: "2026-04-28T00:00:00Z",
        topics: {},
        nodes: {},
        edges: {
          "auth/a|auth/b|uses": {},
        },
      }),
    ).toThrow();
  });

  test("rejects edge key with too few segments", () => {
    expect(() =>
      GraphFileSchema.parse({
        version: 1,
        created_at: "2026-04-28T00:00:00Z",
        topics: {},
        nodes: {},
        edges: {
          "auth/a|auth/b": {},
        },
      }),
    ).toThrow();
  });

  test("rejects edge key with empty from", () => {
    expect(() =>
      GraphFileSchema.parse({
        version: 1,
        created_at: "2026-04-28T00:00:00Z",
        topics: {},
        nodes: {},
        edges: {
          "|auth/b|depends_on": {},
        },
      }),
    ).toThrow();
  });

  test("accepts edge key for every valid kind in the enum", () => {
    for (const kind of EdgeKindSchema.options) {
      expect(() =>
        GraphFileSchema.parse({
          version: 1,
          created_at: "2026-04-28T00:00:00Z",
          topics: {},
          nodes: {},
          edges: {
            [`a|b|${kind}`]: {},
          },
        }),
      ).not.toThrow();
    }
  });

  test("rejects nodes map key containing '|'", () => {
    expect(() =>
      GraphFileSchema.parse({
        version: 1,
        created_at: "2026-04-28T00:00:00Z",
        topics: {},
        nodes: {
          "auth|bad": {
            kind: "invariant",
            name: "x",
            summary: "x",
            sources: [],
            tags: [],
            aliases: [],
            status: "active",
            confidence: 0.9,
            last_verified_at: "2026-04-28T00:00:00Z",
          },
        },
        edges: {},
      }),
    ).toThrow();
  });
});

// =============================================================
// Fixture-driven parametric tests (task-010)
// =============================================================

const SCHEMA_VALID_FIXTURES = [
  "empty.json",
  "small.json",
  "with-aliases.json",
  "with-collision-pairs.json",
  "with-deprecated.json",
  "knowledge-kinds.json",
  "dangling-edges.json",
  "alias-collision.json",
  "missing-topic.json",
  "mixed.json",
  "oversize.json",
];

describe("GraphFileSchema — fixture corpus", () => {
  for (const fixture of SCHEMA_VALID_FIXTURES) {
    test(`parses ${fixture} cleanly`, () => {
      const data = loadFixture(fixture);
      expect(() => GraphFileSchema.parse(data)).not.toThrow();
    });
  }

  test("rejects malformed-schema.json (intentionally invalid)", () => {
    const data = loadFixture("malformed-schema.json");
    expect(() => GraphFileSchema.parse(data)).toThrow();
  });
});

// =============================================================
// edgeKey helper
// =============================================================

describe("edgeKey", () => {
  test("builds the canonical from|to|kind triple", () => {
    expect(edgeKey("auth/middleware", "auth/jwt", "depends_on")).toBe(
      "auth/middleware|auth/jwt|depends_on",
    );
  });

  test("works with the widened kinds", () => {
    expect(edgeKey("a", "b", "derived_from")).toBe("a|b|derived_from");
    expect(edgeKey("a", "b", "mirrors")).toBe("a|b|mirrors");
  });
});

describe("parseEdgeKey", () => {
  test("parses the canonical from|to|kind triple", () => {
    expect(parseEdgeKey("auth/middleware|auth/jwt|depends_on")).toEqual({
      from: "auth/middleware",
      to: "auth/jwt",
      kind: "depends_on",
    });
  });

  test("rejects malformed keys and invented kinds", () => {
    expect(parseEdgeKey("auth/a|auth/b")).toBeNull();
    expect(parseEdgeKey("auth/a|auth/b|uses")).toBeNull();
    expect(parseEdgeKey("auth/a|auth/b|auth/c|depends_on")).toBeNull();
  });
});
