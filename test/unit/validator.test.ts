import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { GraphStore } from "../../src/graph.js";
import { applyRepairs, validate } from "../../src/validator.js";
import type { GraphFile } from "../../src/types.js";

// =============================================================
// validator — pure function tests
// =============================================================

function makeGraph(overrides: Partial<GraphFile> = {}): GraphFile {
  return {
    version: 1,
    created_at: "2026-04-28T12:00:00Z",
    topics: {},
    nodes: {},
    edges: {},
    ...overrides,
  };
}

function makeStoredNode(extra: Record<string, unknown> = {}) {
  return {
    kind: "invariant" as const,
    name: "Test node",
    summary: "summary",
    sources: [
      {
        file_path: "src/x.ts",
        line_range: [1, 10] as [number, number],
        content_hash: "sha256:placeholder",
      },
    ],
    tags: [],
    aliases: [],
    status: "active" as const,
    confidence: 0.9,
    last_verified_at: "2026-04-28T12:00:00Z",
    ...extra,
  };
}

describe("validate — clean graph", () => {
  test("empty graph is ok with no errors/warnings/repairs", () => {
    const result = validate(makeGraph());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.repairs).toEqual([]);
  });

  test("populated valid graph passes cleanly", () => {
    const graph = makeGraph({
      topics: { auth: { created_at: "2026-04-28T12:00:00Z", auto_created: true } },
      nodes: {
        "auth/a": makeStoredNode({ tags: ["auth"], aliases: ["a-alias"] }),
        "auth/b": makeStoredNode({ tags: ["auth"], aliases: ["b-alias"] }),
      },
      edges: {
        "auth/a|auth/b|depends_on": { note: "uses b" },
      },
    });
    const result = validate(graph);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.repairs).toEqual([]);
  });
});

describe("validate — dangling edges", () => {
  test("detects missing 'from' endpoint", () => {
    const graph = makeGraph({
      nodes: { "auth/b": makeStoredNode() },
      edges: { "auth/a|auth/b|depends_on": {} },
    });
    const result = validate(graph);
    expect(result.repairs).toContainEqual({
      kind: "dangling_edge",
      edgeKey: "auth/a|auth/b|depends_on",
      missingEndpoint: "auth/a",
    });
  });

  test("detects missing 'to' endpoint", () => {
    const graph = makeGraph({
      nodes: { "auth/a": makeStoredNode() },
      edges: { "auth/a|auth/b|depends_on": {} },
    });
    const result = validate(graph);
    expect(result.repairs).toContainEqual({
      kind: "dangling_edge",
      edgeKey: "auth/a|auth/b|depends_on",
      missingEndpoint: "auth/b",
    });
  });

  test("logs both endpoints when both are missing", () => {
    const graph = makeGraph({
      edges: { "auth/a|auth/b|depends_on": {} },
    });
    const result = validate(graph);
    expect(result.repairs).toHaveLength(2);
    expect(result.repairs.map((r) => r.kind)).toEqual([
      "dangling_edge",
      "dangling_edge",
    ]);
  });
});

describe("validate — duplicate aliases", () => {
  test("warns when same alias appears on >1 node", () => {
    const graph = makeGraph({
      nodes: {
        "auth/a": makeStoredNode({ aliases: ["shared"] }),
        "auth/b": makeStoredNode({ aliases: ["shared"] }),
      },
    });
    const result = validate(graph);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual({
      kind: "duplicate_alias",
      alias: "shared",
      nodeIds: ["auth/a", "auth/b"],
    });
  });

  test("does not warn for unique aliases", () => {
    const graph = makeGraph({
      nodes: {
        "auth/a": makeStoredNode({ aliases: ["only-a"] }),
        "auth/b": makeStoredNode({ aliases: ["only-b"] }),
      },
    });
    const result = validate(graph);
    expect(result.warnings).toEqual([]);
  });

  test("aliases on a deprecated node are still considered (not filtered by status)", () => {
    const graph = makeGraph({
      nodes: {
        "auth/a": makeStoredNode({ aliases: ["x"], status: "active" }),
        "auth/b": makeStoredNode({ aliases: ["x"], status: "deprecated" }),
      },
    });
    const result = validate(graph);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.kind).toBe("duplicate_alias");
  });
});

describe("validate — missing topics", () => {
  test("repairs a tag without a corresponding topic entry", () => {
    const graph = makeGraph({
      nodes: { "auth/a": makeStoredNode({ tags: ["auth"] }) },
    });
    const result = validate(graph);
    expect(result.repairs).toContainEqual({
      kind: "missing_topic",
      topic: "auth",
      nodeId: "auth/a",
    });
  });

  test("does not flag tags that already have a topic entry", () => {
    const graph = makeGraph({
      topics: { auth: { created_at: "2026-04-28T12:00:00Z", auto_created: true } },
      nodes: { "auth/a": makeStoredNode({ tags: ["auth"] }) },
    });
    const result = validate(graph);
    expect(result.repairs).toEqual([]);
  });
});

// =============================================================
// applyRepairs
// =============================================================

describe("applyRepairs", () => {
  test("returns the same graph when there are no repairs", () => {
    const graph = makeGraph();
    const result = validate(graph);
    expect(applyRepairs(graph, result)).toBe(graph);
  });

  test("drops dangling edges", () => {
    const graph = makeGraph({
      nodes: { "auth/a": makeStoredNode() },
      edges: { "auth/a|auth/b|depends_on": {} },
    });
    const result = validate(graph);
    const repaired = applyRepairs(graph, result);
    expect(repaired.edges["auth/a|auth/b|depends_on"]).toBeUndefined();
  });

  test("adds missing topics with auto_created: true", () => {
    const graph = makeGraph({
      nodes: { "auth/a": makeStoredNode({ tags: ["auth"] }) },
    });
    const result = validate(graph);
    const repaired = applyRepairs(graph, result);
    expect(repaired.topics.auth?.auto_created).toBe(true);
    expect(repaired.topics.auth?.created_at).toBeDefined();
  });

  test("does not auto-repair duplicate aliases (warning only)", () => {
    const graph = makeGraph({
      nodes: {
        "auth/a": makeStoredNode({ aliases: ["shared"] }),
        "auth/b": makeStoredNode({ aliases: ["shared"] }),
      },
    });
    const result = validate(graph);
    const repaired = applyRepairs(graph, result);
    expect(repaired.nodes["auth/a"]?.aliases).toEqual(["shared"]);
    expect(repaired.nodes["auth/b"]?.aliases).toEqual(["shared"]);
  });

  test("does not mutate the input graph", () => {
    const graph = makeGraph({
      nodes: { "auth/a": makeStoredNode() },
      edges: { "auth/a|auth/b|depends_on": {} },
    });
    const result = validate(graph);
    applyRepairs(graph, result);
    // Input graph unchanged
    expect(graph.edges["auth/a|auth/b|depends_on"]).toBeDefined();
  });

  test("idempotent on missing-topic repairs (one entry per topic)", () => {
    const graph = makeGraph({
      nodes: {
        "auth/a": makeStoredNode({ tags: ["auth"] }),
        "auth/b": makeStoredNode({ tags: ["auth"] }),
      },
    });
    const result = validate(graph);
    // Two repair entries (one per node), but only one topic should be added.
    expect(result.repairs).toHaveLength(2);
    const repaired = applyRepairs(graph, result);
    expect(Object.keys(repaired.topics)).toEqual(["auth"]);
  });
});

// =============================================================
// GraphStore.load() integration
// =============================================================

describe("GraphStore.load — validator integration", () => {
  let tmpRoot: string;
  let graphPath: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-validator-"));
    graphPath = path.join(tmpRoot, ".codemap", "graph.json");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeGraph(content: object) {
    await fs.mkdir(path.dirname(graphPath), { recursive: true });
    await fs.writeFile(graphPath, JSON.stringify(content));
  }

  test("applies dangling-edge repairs in-memory on load", async () => {
    await writeGraph({
      version: 1,
      created_at: "2026-04-28T12:00:00Z",
      topics: {},
      nodes: { "auth/a": makeStoredNode() },
      edges: {
        // auth/b doesn't exist — dangling
        "auth/a|auth/b|depends_on": {},
      },
    });
    const store = await GraphStore.load(tmpRoot);
    expect(store._data().edges["auth/a|auth/b|depends_on"]).toBeUndefined();
  });

  test("applies missing-topic repairs in-memory on load", async () => {
    await writeGraph({
      version: 1,
      created_at: "2026-04-28T12:00:00Z",
      topics: {},
      nodes: { "auth/a": makeStoredNode({ tags: ["auth"] }) },
      edges: {},
    });
    const store = await GraphStore.load(tmpRoot);
    expect(store._data().topics.auth?.auto_created).toBe(true);
  });

  test("preserves duplicate-alias warnings without auto-repairing", async () => {
    await writeGraph({
      version: 1,
      created_at: "2026-04-28T12:00:00Z",
      topics: {},
      nodes: {
        "auth/a": makeStoredNode({ aliases: ["shared"] }),
        "auth/b": makeStoredNode({ aliases: ["shared"] }),
      },
      edges: {},
    });
    const store = await GraphStore.load(tmpRoot);
    expect(store._data().nodes["auth/a"]?.aliases).toEqual(["shared"]);
    expect(store._data().nodes["auth/b"]?.aliases).toEqual(["shared"]);
    expect(store.validationResult()?.warnings.length).toBe(1);
  });

  test("validationResult() returns the last validation outcome", async () => {
    await writeGraph({
      version: 1,
      created_at: "2026-04-28T12:00:00Z",
      topics: {},
      nodes: { "auth/a": makeStoredNode({ tags: ["auth"] }) },
      edges: {},
    });
    const store = await GraphStore.load(tmpRoot);
    const result = store.validationResult();
    expect(result).not.toBeNull();
    expect(result?.repairs).toHaveLength(1);
    expect(result?.repairs[0]?.kind).toBe("missing_topic");
  });

  test("schema-invalid file (e.g. wrong version) propagates as a thrown error", async () => {
    await writeGraph({
      version: 99, // invalid
      created_at: "2026-04-28T12:00:00Z",
      topics: {},
      nodes: {},
      edges: {},
    });
    await expect(GraphStore.load(tmpRoot)).rejects.toThrow();
  });

  test("schema-invalid edge kind in key propagates as a thrown error", async () => {
    // Regression for V1_SPEC §9.8 — edge keys with invalid kind must fail
    // schema parse, not just slip through.
    await writeGraph({
      version: 1,
      created_at: "2026-04-28T12:00:00Z",
      topics: {},
      nodes: { "auth/a": makeStoredNode(), "auth/b": makeStoredNode() },
      edges: {
        "auth/a|auth/b|uses": {}, // invalid: 'uses' not in EdgeKindSchema
      },
    });
    await expect(GraphStore.load(tmpRoot)).rejects.toThrow();
  });

  test("repairs persist on next save() (round-trip)", async () => {
    await writeGraph({
      version: 1,
      created_at: "2026-04-28T12:00:00Z",
      topics: {},
      nodes: { "auth/a": makeStoredNode({ tags: ["auth"] }) },
      edges: {},
    });
    const a = await GraphStore.load(tmpRoot);
    expect(a._data().topics.auth).toBeDefined(); // applied in-memory
    await a.save();

    // Reload — repairs from this load should be a no-op because the prior
    // save() persisted the previously-applied repairs.
    const b = await GraphStore.load(tmpRoot);
    expect(b.validationResult()?.repairs).toHaveLength(0);
    expect(b._data().topics.auth).toBeDefined();
  });

  test("empty graph (no file) produces a clean validation result", async () => {
    const store = await GraphStore.load(tmpRoot);
    const result = store.validationResult();
    expect(result?.ok).toBe(true);
    expect(result?.errors).toEqual([]);
    expect(result?.warnings).toEqual([]);
    expect(result?.repairs).toEqual([]);
  });
});
