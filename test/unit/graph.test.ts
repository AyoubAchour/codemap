import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { GraphStore } from "../../src/graph.js";
import type { Node } from "../../src/types.js";

// =============================================================
// Smoke tests for GraphStore. Comprehensive coverage (incl.
// crash-injection + concurrent save) is task-010.
// =============================================================

let tmpRoot: string;
let graphPath: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-graph-"));
  graphPath = path.join(tmpRoot, ".codemap", "graph.json");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---- helpers ------------------------------------------------

function makeNode(overrides: Partial<Node> & { id: string }): Node {
  return {
    kind: "invariant",
    name: overrides.id,
    summary: "test summary",
    sources: [
      {
        file_path: "src/test.ts",
        line_range: [1, 10] as [number, number],
        content_hash: "sha256:placeholder",
      },
    ],
    tags: ["test"],
    aliases: [],
    status: "active",
    confidence: 0.9,
    last_verified_at: "2026-04-28T12:00:00Z",
    ...overrides,
  };
}

// =============================================================
// load()
// =============================================================

describe("GraphStore.load", () => {
  test("returns an empty store when no file exists", async () => {
    const store = await GraphStore.load(tmpRoot);
    expect(store._data().version).toBe(1);
    expect(Object.keys(store._data().nodes)).toHaveLength(0);
    expect(Object.keys(store._data().edges)).toHaveLength(0);
    expect(Object.keys(store._data().topics)).toHaveLength(0);
  });

  test("does not write to disk on empty load (deferred to first save)", async () => {
    await GraphStore.load(tmpRoot);
    await expect(fs.access(graphPath)).rejects.toThrow();
  });

  test("parses an existing valid graph file", async () => {
    await fs.mkdir(path.dirname(graphPath), { recursive: true });
    await fs.writeFile(
      graphPath,
      JSON.stringify({
        version: 1,
        created_at: "2026-04-28T10:00:00Z",
        topics: {
          auth: { created_at: "2026-04-28T10:00:00Z", auto_created: true },
        },
        nodes: {
          "auth/foo": {
            kind: "gotcha",
            name: "Auth foo",
            summary: "...",
            sources: [],
            tags: ["auth"],
            aliases: ["foo"],
            status: "active",
            confidence: 0.9,
            last_verified_at: "2026-04-28T10:00:00Z",
          },
        },
        edges: {},
      }),
    );

    const store = await GraphStore.load(tmpRoot);
    expect(store.getNode("auth/foo")?.kind).toBe("gotcha");
  });

  test("throws on schema-invalid file", async () => {
    await fs.mkdir(path.dirname(graphPath), { recursive: true });
    await fs.writeFile(
      graphPath,
      JSON.stringify({ version: 99, nodes: {}, edges: {}, topics: {}, created_at: "x" }),
    );
    await expect(GraphStore.load(tmpRoot)).rejects.toThrow();
  });

  test("respects customPath override", async () => {
    const altPath = path.join(tmpRoot, "alt", "g.json");
    const store = await GraphStore.load(tmpRoot, { customPath: altPath });
    await store.save();
    expect((await fs.stat(altPath)).isFile()).toBe(true);
  });
});

// =============================================================
// save() round-trip
// =============================================================

describe("GraphStore.save", () => {
  test("save → load round-trip preserves data", async () => {
    const a = await GraphStore.load(tmpRoot);
    a.ensureTopic("auth", true);
    a.upsertNode(makeNode({ id: "auth/x" }), { activeTopic: "auth" });
    a.ensureEdge("auth/x", "auth/y", "depends_on", "uses Y");
    await a.save();

    const b = await GraphStore.load(tmpRoot);
    expect(b.getNode("auth/x")?.tags).toContain("auth");
    expect(b._data().topics.auth?.auto_created).toBe(true);
    expect(b._data().edges["auth/x|auth/y|depends_on"]?.note).toBe("uses Y");
  });

  test("creates file on first save", async () => {
    const a = await GraphStore.load(tmpRoot);
    a.upsertNode(makeNode({ id: "auth/x" }));
    await a.save();
    expect((await fs.stat(graphPath)).isFile()).toBe(true);
  });

  test("serialized output is sorted-keys + 2-space indent (diff-stable)", async () => {
    const a = await GraphStore.load(tmpRoot);
    a.upsertNode(makeNode({ id: "z/last" }));
    a.upsertNode(makeNode({ id: "a/first" }));
    await a.save();

    const raw = await fs.readFile(graphPath, "utf8");
    // top-level keys sorted alphabetically
    const topLevelOrder = raw.match(/^\s*"(\w+)":/gm)?.map((s) => s.trim());
    expect(topLevelOrder?.[0]).toMatch(/"created_at"/);
    // 2-space indent (third line of a non-empty graph should start with 2 spaces)
    expect(raw.split("\n")[1]).toMatch(/^  /);
  });
});

// =============================================================
// getNode — direct + alias
// =============================================================

describe("GraphStore.getNode", () => {
  test("direct lookup hit", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({ id: "auth/jwt" }));
    expect(store.getNode("auth/jwt")?.id).toBe("auth/jwt");
  });

  test("returns null on miss", async () => {
    const store = await GraphStore.load(tmpRoot);
    expect(store.getNode("does/not/exist")).toBeNull();
  });

  test("resolves through aliases", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({ id: "auth/jwt", aliases: ["JWT", "jwt-utils"] }));
    expect(store.getNode("JWT")?.id).toBe("auth/jwt");
    expect(store.getNode("jwt-utils")?.id).toBe("auth/jwt");
  });
});

// =============================================================
// upsertNode — create + merge
// =============================================================

describe("GraphStore.upsertNode", () => {
  test("creates a new node when id is fresh", async () => {
    const store = await GraphStore.load(tmpRoot);
    const result = store.upsertNode(makeNode({ id: "auth/new" }));
    expect(result.merged).toBe(false);
    expect(result.createdId).toBe("auth/new");
  });

  test("auto-tags the active topic on create", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({ id: "auth/x" }), { activeTopic: "auth" });
    expect(store.getNode("auth/x")?.tags).toContain("auth");
  });

  test("merges into existing id: extends tags, merges aliases, refreshes timestamp", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({
      id: "auth/x",
      tags: ["auth"],
      aliases: ["a1"],
      last_verified_at: "2026-01-01T00:00:00Z",
    }));
    const result = store.upsertNode(makeNode({
      id: "auth/x",
      tags: ["security"],
      aliases: ["a2"],
      last_verified_at: "2026-04-28T12:00:00Z",
    }), { activeTopic: "perf" });

    expect(result.merged).toBe(true);
    const merged = store.getNode("auth/x")!;
    expect(merged.tags).toEqual(expect.arrayContaining(["auth", "security", "perf"]));
    expect(merged.aliases).toEqual(expect.arrayContaining(["a1", "a2"]));
    expect(merged.last_verified_at).toBe("2026-04-28T12:00:00Z");
  });

  test("replaces summary only if incoming confidence ≥ existing (replace case)", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({
      id: "auth/x", summary: "old", confidence: 0.5,
    }));
    store.upsertNode(makeNode({
      id: "auth/x", summary: "new (higher conf)", confidence: 0.9,
    }));
    expect(store.getNode("auth/x")?.summary).toBe("new (higher conf)");
    expect(store.getNode("auth/x")?.confidence).toBe(0.9);
  });

  test("replaces summary only if incoming confidence ≥ existing (preserve case)", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({
      id: "auth/x", summary: "old (high conf)", confidence: 0.9,
    }));
    store.upsertNode(makeNode({
      id: "auth/x", summary: "speculative", confidence: 0.5,
    }));
    expect(store.getNode("auth/x")?.summary).toBe("old (high conf)");
    expect(store.getNode("auth/x")?.confidence).toBe(0.9);
  });

  test("mergeWith targets a different existing id", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({ id: "auth/canonical", tags: ["auth"] }));
    const result = store.upsertNode(
      makeNode({ id: "auth/duplicate", tags: ["new"] }),
      { mergeWith: "auth/canonical" },
    );
    expect(result.merged).toBe(true);
    expect(result.createdId).toBe("auth/canonical");
    expect(store.getNode("auth/canonical")?.tags).toEqual(
      expect.arrayContaining(["auth", "new"]),
    );
    // The would-be-new id was NOT created
    expect(store._data().nodes["auth/duplicate"]).toBeUndefined();
  });

  test("mergeWith targeting a missing id creates at the target id (not node.id)", async () => {
    // Greptile P1: previously this branch silently created at node.id,
    // abandoning the caller's "write to this canonical id" intent.
    const store = await GraphStore.load(tmpRoot);
    const result = store.upsertNode(
      makeNode({ id: "auth/incoming", tags: ["new"] }),
      { mergeWith: "auth/canonical" },
    );
    expect(result.merged).toBe(false); // target didn't exist; this was a creation
    expect(result.createdId).toBe("auth/canonical");
    expect(store.getNode("auth/canonical")?.tags).toEqual(
      expect.arrayContaining(["new"]),
    );
    // Crucially: NOT created at node.id
    expect(store._data().nodes["auth/incoming"]).toBeUndefined();
  });

  test("status: incoming wins (allows deprecation)", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({ id: "auth/x", status: "active" }));
    store.upsertNode(makeNode({ id: "auth/x", status: "deprecated" }));
    expect(store.getNode("auth/x")?.status).toBe("deprecated");
  });

  test("kind and name don't flap on merge (canonical from first emit)", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({ id: "auth/x", kind: "invariant", name: "Original" }));
    store.upsertNode(makeNode({ id: "auth/x", kind: "gotcha", name: "Different" }));
    expect(store.getNode("auth/x")?.kind).toBe("invariant");
    expect(store.getNode("auth/x")?.name).toBe("Original");
  });
});

// =============================================================
// ensureEdge / ensureTopic
// =============================================================

describe("GraphStore.ensureEdge", () => {
  test("creates a new edge", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.ensureEdge("a", "b", "depends_on", "test note");
    expect(store._data().edges["a|b|depends_on"]?.note).toBe("test note");
  });

  test("idempotent on same triple without note", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.ensureEdge("a", "b", "depends_on", "first note");
    store.ensureEdge("a", "b", "depends_on");
    // Note preserved on no-op
    expect(store._data().edges["a|b|depends_on"]?.note).toBe("first note");
  });

  test("updates note when called again with new note", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.ensureEdge("a", "b", "depends_on", "first");
    store.ensureEdge("a", "b", "depends_on", "second");
    expect(store._data().edges["a|b|depends_on"]?.note).toBe("second");
  });

  test("different kinds on same (from, to) coexist", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.ensureEdge("a", "b", "imports");
    store.ensureEdge("a", "b", "depends_on");
    expect(Object.keys(store._data().edges)).toEqual(
      expect.arrayContaining(["a|b|imports", "a|b|depends_on"]),
    );
  });
});

describe("GraphStore.ensureTopic", () => {
  test("creates a new topic", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.ensureTopic("auth");
    expect(store._data().topics.auth?.auto_created).toBe(true);
  });

  test("idempotent: existing topic preserved", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.ensureTopic("auth", true);
    const created = store._data().topics.auth?.created_at;
    // small delay to make sure timestamps would differ if a re-create happened
    await new Promise((r) => setTimeout(r, 10));
    store.ensureTopic("auth", false);
    expect(store._data().topics.auth?.created_at).toBe(created);
    expect(store._data().topics.auth?.auto_created).toBe(true);
  });
});

// =============================================================
// query — basic sanity (full coverage in task-010)
// =============================================================

describe("GraphStore.query", () => {
  test("returns matches scored by tag + name + alias overlap", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({
      id: "auth/middleware",
      name: "Auth middleware",
      tags: ["auth", "security"],
    }));
    store.upsertNode(makeNode({ id: "billing/stripe", tags: ["billing"] }));

    const result = store.query("auth", 5);
    expect(result.nodes.map((n) => n.id)).toEqual(["auth/middleware"]);
  });

  test("excludes deprecated nodes by default", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({
      id: "auth/old", tags: ["auth"], status: "deprecated",
    }));
    store.upsertNode(makeNode({ id: "auth/new", tags: ["auth"] }));

    const result = store.query("auth", 5);
    expect(result.nodes.map((n) => n.id)).toEqual(["auth/new"]);
  });

  test("returns connecting edges between nodes in the result set", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(makeNode({ id: "auth/a", tags: ["auth"] }));
    store.upsertNode(makeNode({ id: "auth/b", tags: ["auth"] }));
    store.ensureEdge("auth/a", "auth/b", "depends_on", "note");

    const result = store.query("auth", 5);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({
      from: "auth/a",
      to: "auth/b",
      kind: "depends_on",
      note: "note",
    });
  });

  test("respects limit", async () => {
    const store = await GraphStore.load(tmpRoot);
    for (let i = 0; i < 5; i++) {
      store.upsertNode(makeNode({ id: `auth/n${i}`, tags: ["auth"] }));
    }
    const result = store.query("auth", 3);
    expect(result.nodes).toHaveLength(3);
  });

  test("tag matching is substring (consistent with name/summary)", async () => {
    // Greptile P2: tagsLower.includes(token) was exact-match while name/summary
    // used substring — so a tag "authentication" wouldn't match query "auth"
    // even though the same word in name would. Now symmetric.
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(
      makeNode({
        id: "auth/x",
        name: "x",
        summary: "x",
        tags: ["authentication"],
      }),
    );
    const result = store.query("auth", 5);
    expect(result.nodes.map((n) => n.id)).toEqual(["auth/x"]);
  });

  test("alias matching is substring (consistent with name/summary)", async () => {
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode(
      makeNode({
        id: "auth/x",
        name: "x",
        summary: "x",
        tags: [],
        aliases: ["authentication"],
      }),
    );
    const result = store.query("auth", 5);
    expect(result.nodes.map((n) => n.id)).toEqual(["auth/x"]);
  });
});
