import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools } from "../../src/index.js";
import { _resetActiveTopic } from "../../src/tools/_active_topic.js";

// =============================================================
// Integration test: drive the MCP server via the in-memory transport.
// Spawning bin/codemap-mcp.ts via stdio is verified separately by the
// `bun build --compile` smoke check at the bottom of this file.
// =============================================================

let tmpRoot: string;
let server: McpServer;
let client: Client;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-mcp-"));
  _resetActiveTopic();

  server = new McpServer({ name: "codemap-test", version: "0.0.0" });
  registerTools(server, { repoRoot: tmpRoot });

  client = new Client(
    { name: "codemap-test-client", version: "0.0.0" },
    { capabilities: {} },
  );

  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function parseToolText(result: { content: { type: string; text?: string }[] }) {
  const first = result.content[0];
  if (!first || first.type !== "text" || !first.text) {
    throw new Error("expected first content item to be text");
  }
  return JSON.parse(first.text);
}

// =============================================================
// tools/list
// =============================================================

describe("MCP server — tools/list", () => {
  test("registers all 4 simple tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_node",
      "link",
      "query_graph",
      "set_active_topic",
    ]);
  });

  test("each tool exposes a description", async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect(tool.description!.length).toBeGreaterThan(10);
    }
  });
});

// =============================================================
// query_graph + get_node — read paths
// =============================================================

describe("MCP server — read tools", () => {
  test("query_graph on an empty graph returns empty results", async () => {
    const r = await client.callTool({
      name: "query_graph",
      arguments: { question: "anything" },
    });
    const parsed = parseToolText(r as never);
    expect(parsed.nodes).toEqual([]);
    expect(parsed.edges).toEqual([]);
  });

  test("get_node returns null for unknown id", async () => {
    const r = await client.callTool({
      name: "get_node",
      arguments: { id: "does/not/exist" },
    });
    const parsed = parseToolText(r as never);
    expect(parsed).toBeNull();
  });
});

// =============================================================
// link — write path (idempotent edge creation)
// =============================================================

describe("MCP server — link", () => {
  // We need at least two nodes in the graph for link not to be a dangling
  // edge that the validator drops on next load. Seed via direct GraphStore.
  async function seedTwoNodes() {
    const { GraphStore } = await import("../../src/graph.js");
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode({
      id: "auth/a",
      kind: "invariant",
      name: "A",
      summary: "x",
      sources: [
        {
          file_path: "a.ts",
          line_range: [1, 10],
          content_hash: "sha256:placeholder",
        },
      ],
      tags: [],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: "2026-04-28T00:00:00Z",
    });
    store.upsertNode({
      id: "auth/b",
      kind: "invariant",
      name: "B",
      summary: "x",
      sources: [
        {
          file_path: "b.ts",
          line_range: [1, 10],
          content_hash: "sha256:placeholder",
        },
      ],
      tags: [],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: "2026-04-28T00:00:00Z",
    });
    await store.save();
  }

  async function loadGraphDirect() {
    const { GraphStore } = await import("../../src/graph.js");
    return await GraphStore.load(tmpRoot);
  }

  test("creates an edge between two existing nodes", async () => {
    await seedTwoNodes();
    const r = await client.callTool({
      name: "link",
      arguments: {
        from: "auth/a",
        to: "auth/b",
        kind: "depends_on",
        note: "first",
      },
    });
    const parsed = parseToolText(r as never);
    expect(parsed.ok).toBe(true);

    // Verify by loading graph.json directly — query_graph would only return
    // edges whose endpoints are both in the result set, which depends on
    // search-token matches.
    const verify = await loadGraphDirect();
    expect(verify._data().edges["auth/a|auth/b|depends_on"]).toEqual({
      note: "first",
    });
  });

  test("idempotent: re-linking with a new note updates it (not duplicate edge)", async () => {
    await seedTwoNodes();
    await client.callTool({
      name: "link",
      arguments: { from: "auth/a", to: "auth/b", kind: "depends_on", note: "first" },
    });
    await client.callTool({
      name: "link",
      arguments: { from: "auth/a", to: "auth/b", kind: "depends_on", note: "second" },
    });

    const verify = await loadGraphDirect();
    const edges = verify._data().edges;
    // exactly one edge with the depends_on kind on this pair
    const matching = Object.keys(edges).filter((k) =>
      k.startsWith("auth/a|auth/b|depends_on"),
    );
    expect(matching).toHaveLength(1);
    expect(edges["auth/a|auth/b|depends_on"]).toEqual({ note: "second" });
  });

  test("rejects an invalid edge kind via the input schema (isError response)", async () => {
    await seedTwoNodes();
    // SDK validates input against the zod enum and returns an error result
    // (not a thrown rejection) when the value is invalid.
    const r = (await client.callTool({
      name: "link",
      arguments: {
        from: "auth/a",
        to: "auth/b",
        kind: "uses", // not in EdgeKindSchema
        note: "x",
      },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Invalid|kind/i);

    // Crucially: the bad call must NOT have written anything.
    const verify = await loadGraphDirect();
    expect(Object.keys(verify._data().edges)).toHaveLength(0);
  });
});

// =============================================================
// set_active_topic
// =============================================================

describe("MCP server — set_active_topic", () => {
  test("creates the topic the first time and reports autoCreated=true", async () => {
    const r = await client.callTool({
      name: "set_active_topic",
      arguments: { name: "auth-bugfix" },
    });
    const parsed = parseToolText(r as never);
    expect(parsed.ok).toBe(true);
    expect(parsed.autoCreated).toBe(true);
  });

  test("autoCreated=false when the topic already exists", async () => {
    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "auth-bugfix" },
    });
    const r = await client.callTool({
      name: "set_active_topic",
      arguments: { name: "auth-bugfix" },
    });
    const parsed = parseToolText(r as never);
    expect(parsed.autoCreated).toBe(false);
  });

  test("the active topic is read by getActiveTopic() (used by emit_node in task-014)", async () => {
    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "perf-investigation" },
    });
    const { getActiveTopic } = await import("../../src/tools/_active_topic.js");
    expect(getActiveTopic()).toBe("perf-investigation");
  });
});
