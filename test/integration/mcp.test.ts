import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "../../src/index.js";
import { SERVER_INSTRUCTIONS } from "../../src/instructions.js";
import { _resetActiveTopic } from "../../src/tools/_active_topic.js";

const execFileAsync = promisify(execFile);

// =============================================================
// Integration test: drive the MCP server via the in-memory transport.
// Spawning bin/codemap-mcp.ts via stdio is verified separately by the
// `bun build --compile` smoke check at the bottom of this file.
// =============================================================

let tmpRoot: string;
let server: McpServer;
let client: Client;

async function seedRepoFiles() {
  const files = [
    "src/x.ts",
    "src/y.ts",
    "src/messaging/twilio.ts",
    "src/auth/distinct.ts",
    "x.ts",
    ...Array.from({ length: 6 }, (_value, i) => `src/cap-${i}.ts`),
  ];

  await Promise.all(
    files.map(async (filePath) => {
      const absolutePath = path.join(tmpRoot, filePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, `// test source: ${filePath}\n`);
    }),
  );
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-mcp-"));
  await seedRepoFiles();
  _resetActiveTopic();

  // Mirror the production entry (bin/codemap-mcp.ts) — same options shape.
  // The instructions string is part of the server contract since v0.1.1
  // (see task-018) and reaches the client at initialize time.
  server = new McpServer(
    { name: "codemap-test", version: "0.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
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

async function repoFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(path.join(tmpRoot, filePath));
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function runGit(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: tmpRoot });
}

function seededFileHash(filePath: string): string {
  return `sha256:${createHash("sha256")
    .update(`// test source: ${filePath}\n`)
    .digest("hex")}`;
}

// =============================================================
// initialize — server.instructions reaches the client
// (added v0.1.1 / task-018 — the M3a fix that makes agents
// actually write back to the graph instead of treating it as
// a read-only cache).
// =============================================================

describe("MCP server — initialize / instructions", () => {
  test("client receives the lifecycle instructions string after handshake", () => {
    // beforeEach already completed connect() on both sides, so the
    // initialize handshake has run. getInstructions() returns whatever
    // the server passed via its second constructor arg.
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
  });

  test("instructions name every tool by its lifecycle role", () => {
    // The wording is the contract for downstream agents — if any of
    // these names disappears from the instructions, the lifecycle
    // policy goes ambiguous and we regress the M3a fix.
    const instructions = client.getInstructions() ?? "";
    for (const toolName of [
      "set_active_topic",
      "query_context",
      "query_graph",
      "get_node",
      "graph_health",
      "suggest_writeback",
      "emit_node",
      "link",
    ]) {
      expect(instructions).toContain(toolName);
    }
  });

  test("instructions explicitly forbid the 'cache' interpretation", () => {
    // The single sentence that addresses what Codex did in M3a prompt 1:
    // query miss → fall back to direct exploration → don't write back.
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("WRITE AFTER");
    expect(instructions.toLowerCase()).toContain("leaves something behind");
  });
});

// =============================================================
// tools/list
// =============================================================

describe("MCP server — tools/list", () => {
  test("registers graph-memory and source-index tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "changes_context",
      "clear_index",
      "emit_node",
      "get_index_status",
      "get_node",
      "graph_health",
      "index_codebase",
      "link",
      "query_context",
      "query_graph",
      "search_source",
      "set_active_topic",
      "suggest_writeback",
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

  // task-022 / v0.2.0: emit_node's tags + last_verified_at descriptions are
  // tightened to address M3a findings F4 (tag inflation: agent uses kind
  // names as tags) + F5 (agent invented round-number future timestamps).
  // Pin both descriptions so future edits don't silently regress.
  test("emit_node descriptions guide agents away from M3a quirks", async () => {
    const result = await client.listTools();
    const emit = result.tools.find((t) => t.name === "emit_node");
    expect(emit).toBeDefined();
    const props = (
      emit!.inputSchema as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;

    // F4 — tags description must steer away from kind names + meta-categories
    const tagsDesc = props.tags?.description ?? "";
    expect(tagsDesc).toContain("Domain slugs");
    expect(tagsDesc).toContain("NOT kind names");
    expect(tagsDesc).toContain("NOT meta-categories");

    // F5 — last_verified_at description must steer away from round/future values
    const tsDesc = props.last_verified_at?.description ?? "";
    expect(tsDesc).toContain("Current");
    expect(tsDesc).toContain("not a round-number");

    // Scope — emit_node must remain codebase-memory, not general chat memory.
    const toolDesc = emit!.description ?? "";
    expect(toolDesc).toContain("codebase-relevant");
    expect(toolDesc).toContain("never for general Q&A");
    const sourcesDesc = props.sources?.description ?? "";
    expect(sourcesDesc).toContain("Real repo-relative files");
    expect(sourcesDesc).toContain("external URLs");
  });

  // task-019 / v0.1.2: pin emit_node's input schema shape to OpenAI-class
  // compatibility. If either of these regress, Codex Desktop drops the tool
  // from the agent's view and the M3a writeback chain breaks again.
  test("emit_node schema is OpenAI-function-call compatible", async () => {
    const result = await client.listTools();
    const emit = result.tools.find((t) => t.name === "emit_node");
    expect(emit).toBeDefined();
    const schema = emit!.inputSchema as {
      properties: Record<string, { pattern?: string; items?: unknown }>;
    };

    // 1. last_verified_at: no `pattern` regex (Zod's z.iso.datetime() emits
    //    a ~350-char leap-year regex that OpenAI's function-call subset
    //    rejects). Plain string + runtime validation in the handler.
    const ts = schema.properties.last_verified_at;
    expect(ts).toBeDefined();
    expect(ts.pattern).toBeUndefined();

    // 2. sources[].line_range: uniform-array `items` (not the older
    //    tuple-array `items: [...]` syntax that some validators choke on).
    const sources = schema.properties.sources as {
      items: { properties: Record<string, { items?: unknown }> };
    };
    const lineRangeItems = sources.items.properties.line_range?.items;
    expect(Array.isArray(lineRangeItems)).toBe(false);
    expect(lineRangeItems).toBeDefined();
  });
});

// =============================================================
// source index tools — rebuildable discovery cache
// =============================================================

describe("MCP server — source index tools", () => {
  test("index_codebase builds a source index and search_source returns chunks", async () => {
    await fs.writeFile(
      path.join(tmpRoot, "src/auth/distinct.ts"),
      [
        "export interface AuthenticatedActor { id: string }",
        "export function requireActiveUser(token: string): AuthenticatedActor {",
        "  return { id: token };",
        "}",
      ].join("\n"),
    );

    const indexResult = await client.callTool({
      name: "index_codebase",
      arguments: {},
    });
    const indexed = parseToolText(indexResult as never);
    expect(indexed.ok).toBe(true);
    expect(indexed.stats.files_indexed).toBeGreaterThan(0);

    const searchResult = await client.callTool({
      name: "search_source",
      arguments: {
        query: "requireActiveUser auth",
        limit: 2,
        include_impact: true,
      },
    });
    const searched = parseToolText(searchResult as never);
    expect(searched.ok).toBe(true);
    expect(searched.results[0].file_path).toBe("src/auth/distinct.ts");
    expect(searched.results[0].symbols.map((s: { name: string }) => s.name)).toContain(
      "requireActiveUser",
    );
    expect(searched.results[0].impact_context.target).toEqual(
      expect.objectContaining({
        type: "symbol",
        value: "requireActiveUser",
        file_path: "src/auth/distinct.ts",
      }),
    );
  });

  test("get_index_status reports missing and fresh index states", async () => {
    const before = parseToolText(
      (await client.callTool({
        name: "get_index_status",
        arguments: {},
      })) as never,
    );
    expect(before.indexed).toBe(false);

    await client.callTool({ name: "index_codebase", arguments: {} });
    const after = parseToolText(
      (await client.callTool({
        name: "get_index_status",
        arguments: {},
      })) as never,
    );
    expect(after.indexed).toBe(true);
    expect(after.fresh).toBe(true);
  });

  test("clear_index removes the source cache without touching graph memory", async () => {
    await client.callTool({ name: "index_codebase", arguments: {} });
    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "source-index-test" },
    });
    await client.callTool({
      name: "emit_node",
      arguments: {
        id: "source/test",
        kind: "invariant",
        name: "Source test",
        summary: "Graph memory is separate from source index cache.",
        sources: [
          {
            file_path: "src/x.ts",
            line_range: [1, 1],
            content_hash: await repoFileHash("src/x.ts"),
          },
        ],
        tags: ["source"],
        aliases: [],
        status: "active",
        confidence: 0.9,
        last_verified_at: new Date().toISOString(),
      },
    });

    const clear = parseToolText(
      (await client.callTool({ name: "clear_index", arguments: {} })) as never,
    );
    expect(clear.ok).toBe(true);

    const status = parseToolText(
      (await client.callTool({
        name: "get_index_status",
        arguments: {},
      })) as never,
    );
    expect(status.indexed).toBe(false);

    const graphResult = parseToolText(
      (await client.callTool({
        name: "get_node",
        arguments: { id: "source/test" },
      })) as never,
    );
    expect(graphResult.id).toBe("source/test");
  });

  test("query_context fuses graph, source search, and deduplicated related nodes", async () => {
    await fs.writeFile(
      path.join(tmpRoot, "src/auth/distinct.ts"),
      [
        "export interface AuthenticatedActor { id: string }",
        "export function requireActiveUser(token: string): AuthenticatedActor {",
        "  return { id: token };",
        "}",
      ].join("\n"),
    );

    const { GraphStore } = await import("../../src/graph.js");
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode({
      id: "auth/active-user",
      kind: "invariant",
      name: "Active user auth invariant",
      summary: "requireActiveUser returns an authenticated actor.",
      sources: [
        {
          file_path: "src/auth/distinct.ts",
          line_range: [1, 1],
          content_hash: await repoFileHash("src/auth/distinct.ts"),
        },
        {
          file_path: "src/auth/distinct.ts",
          line_range: [2, 4],
          content_hash: await repoFileHash("src/auth/distinct.ts"),
        },
      ],
      tags: ["auth"],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: new Date().toISOString(),
    });
    await store.save();

    const result = await client.callTool({
      name: "query_context",
      arguments: {
        question: "requireActiveUser auth",
        source_limit: 2,
        include_impact: true,
      },
    });
    const parsed = parseToolText(result as never);

    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe("standard");
    expect(parsed.summary.graph_memories[0].id).toBe("auth/active-user");
    expect(parsed.summary.source_hits[0].file_path).toBe(
      "src/auth/distinct.ts",
    );
    expect(parsed.expansion.graph_nodes[0].arguments.id).toBe(
      "auth/active-user",
    );
    expect(parsed.graph.nodes[0].id).toBe("auth/active-user");
    expect(parsed.graph.matches[0]).toEqual(
      expect.objectContaining({
        node_id: "auth/active-user",
        quality: expect.objectContaining({
          freshness: "fresh",
          trust: "high",
        }),
        match_reasons: expect.arrayContaining([
          expect.objectContaining({ field: "tag", value: "auth" }),
        ]),
      }),
    );
    expect(parsed.graph.memory_quality.high_trust_node_ids).toEqual([
      "auth/active-user",
    ]);
    expect(parsed.graph.memory_quality.review_node_ids).toEqual([]);
    expect(parsed.source.refreshed).toBe(true);
    expect(parsed.source.status.indexed).toBe(true);
    expect(parsed.source.search.ok).toBe(true);
    expect(parsed.source.search.results[0].file_path).toBe(
      "src/auth/distinct.ts",
    );
    expect(parsed.source.search.results[0].match_reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "symbol", value: "requireActiveUser" }),
      ]),
    );
    expect(parsed.source.search.results[0].score_breakdown.symbol).toBeGreaterThan(
      0,
    );
    expect(parsed.source.search.results[0].impact_context.target.value).toBe(
      "requireActiveUser",
    );
    expect(parsed.related_nodes.map((n: { id: string }) => n.id)).toEqual([
      "auth/active-user",
    ]);
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Graph matches are curated repo memory"),
        expect.stringContaining("Source hits come from the rebuildable local index"),
        expect.stringContaining("Impact context is bounded planning context"),
      ]),
    );
  });

  test("changes_context reports dirty git impact with structured content", async () => {
    await fs.writeFile(
      path.join(tmpRoot, "src/auth/distinct.ts"),
      [
        "export function requireActiveUser(token: string) {",
        "  return { id: token };",
        "}",
      ].join("\n"),
    );
    await client.callTool({ name: "index_codebase", arguments: {} });
    await runGit(["init"]);
    await runGit(["config", "user.email", "test@example.com"]);
    await runGit(["config", "user.name", "Test User"]);
    await runGit(["add", "."]);
    await runGit(["commit", "-m", "seed"]);
    await fs.writeFile(
      path.join(tmpRoot, "src/auth/distinct.ts"),
      [
        "export function requireActiveUser(token: string) {",
        "  if (!token) throw new Error('missing token');",
        "  return { id: token };",
        "}",
      ].join("\n"),
    );

    const result = (await client.callTool({
      name: "changes_context",
      arguments: { file_limit: 3, include_writeback: false },
    })) as {
      structuredContent?: {
        ok?: boolean;
        git?: { has_changes?: boolean };
        files?: Array<{ file_path?: string }>;
      };
      content: { type: string; text?: string }[];
    };
    const parsed = parseToolText(result);

    expect(result.structuredContent?.ok).toBe(true);
    expect(result.structuredContent?.git?.has_changes).toBe(true);
    expect(parsed.files[0].file_path).toBe("src/auth/distinct.ts");
    expect(parsed.writeback).toBeNull();
  });

  test("query_context does not warn on ordinary medium-trust graph memory", async () => {
    const { GraphStore } = await import("../../src/graph.js");
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode({
      id: "auth/medium-user",
      kind: "invariant",
      name: "Medium trust auth memory",
      summary: "Auth memory can be fresh and useful without being high trust.",
      sources: [
        {
          file_path: "src/x.ts",
          line_range: [1, 1],
          content_hash: await repoFileHash("src/x.ts"),
        },
      ],
      tags: ["auth"],
      aliases: [],
      status: "active",
      confidence: 0.62,
      last_verified_at: new Date().toISOString(),
    });
    await store.save();

    const result = await client.callTool({
      name: "query_context",
      arguments: {
        question: "auth medium memory",
        source_limit: 1,
      },
    });
    const parsed = parseToolText(result as never);

    expect(parsed.ok).toBe(true);
    expect(parsed.graph.memory_quality.review_node_ids).toEqual([
      "auth/medium-user",
    ]);
    expect(parsed.graph.memory_quality.low_trust_node_ids).toEqual([]);
    expect(parsed.warnings.join("\n")).not.toContain("low-trust");
  });

  test("graph_health reports stale active source anchors", async () => {
    const { GraphStore } = await import("../../src/graph.js");
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode({
      id: "health/stale",
      kind: "gotcha",
      name: "Health stale node",
      summary: "Old source hashes should be visible in graph health.",
      sources: [
        {
          file_path: "src/x.ts",
          line_range: [1, 1],
          content_hash: "sha256:old",
        },
      ],
      tags: ["health"],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: new Date().toISOString(),
    });
    await store.save();

    const result = await client.callTool({
      name: "graph_health",
      arguments: {},
    });
    const parsed = parseToolText(result as never);

    expect(parsed.ok).toBe(true);
    expect(parsed.summary.fresh).toBe(false);
    expect(parsed.summary.changed_sources).toBe(1);
    expect(parsed.issues.changed_sources[0].node_id).toBe("health/stale");
  });

  test("suggest_writeback returns read-only capture suggestions", async () => {
    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "auth-review" },
    });

    const result = await client.callTool({
      name: "suggest_writeback",
      arguments: {
        inspected_files: ["src/x.ts"],
        work_summary: "Confirmed auth behavior invariant.",
      },
    });
    const parsed = parseToolText(result as never);

    expect(parsed.ok).toBe(true);
    expect(parsed.active_topic).toBe("auth-review");
    expect(parsed.evidence.inspected_files).toEqual(["src/x.ts"]);
    expect(parsed.suggestions.invariants[0]).toEqual(
      expect.objectContaining({
        kind: "invariant",
        source_candidates: [
          expect.objectContaining({
            file_path: "src/x.ts",
            reasons: expect.arrayContaining(["inspected"]),
          }),
        ],
      }),
    );

    const { GraphStore } = await import("../../src/graph.js");
    const verify = await GraphStore.load(tmpRoot);
    expect(Object.keys(verify._data().nodes)).toEqual([]);
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
    expect(parsed.staleness).toEqual({
      checked_sources: 0,
      stale_sources: [],
      range_fresh_sources: [],
    });
  });

  test("query_graph flags stale source hashes by default", async () => {
    const { GraphStore } = await import("../../src/graph.js");
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode({
      id: "stale/source",
      kind: "gotcha",
      name: "Stale source",
      summary: "This node has an old hash.",
      sources: [
        {
          file_path: "src/x.ts",
          line_range: [1, 1],
          content_hash: "sha256:old",
        },
      ],
      tags: ["stale"],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: "2026-04-28T00:00:00Z",
    });
    await store.save();

    const r = await client.callTool({
      name: "query_graph",
      arguments: { question: "stale" },
    });
    const parsed = parseToolText(r as never);
    expect(parsed.staleness.checked_sources).toBe(1);
    expect(parsed.matches[0].quality).toEqual(
      expect.objectContaining({
        freshness: "stale",
        trust: "low",
        stale_sources: 1,
      }),
    );
    expect(parsed.staleness.stale_sources).toEqual([
      expect.objectContaining({
        node_id: "stale/source",
        file_path: "src/x.ts",
        stored_hash: "sha256:old",
        stale: true,
        reason: "changed",
      }),
    ]);
  });

  test("query_graph reports fresh sources without stale entries", async () => {
    const { GraphStore } = await import("../../src/graph.js");
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode({
      id: "fresh/source",
      kind: "invariant",
      name: "Fresh source",
      summary: "This node has a current hash.",
      sources: [
        {
          file_path: "src/x.ts",
          line_range: [1, 1],
          content_hash: await repoFileHash("src/x.ts"),
        },
      ],
      tags: ["fresh"],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: "2026-04-28T00:00:00Z",
    });
    await store.save();

    const r = await client.callTool({
      name: "query_graph",
      arguments: { question: "fresh" },
    });
    const parsed = parseToolText(r as never);
    expect(parsed.matches[0].quality).toEqual(
      expect.objectContaining({
        freshness: "fresh",
        trust: "high",
        stale_sources: 0,
      }),
    );
    expect(parsed.staleness).toEqual({
      checked_sources: 1,
      stale_sources: [],
      range_fresh_sources: [],
    });
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
      arguments: {
        from: "auth/a",
        to: "auth/b",
        kind: "depends_on",
        note: "first",
      },
    });
    await client.callTool({
      name: "link",
      arguments: {
        from: "auth/a",
        to: "auth/b",
        kind: "depends_on",
        note: "second",
      },
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

// =============================================================
// link — endpoint validation (greptile P1 regression)
// =============================================================

describe("MCP server — link endpoint validation", () => {
  // Repeat the seed helper inline; importing across describe blocks is awkward.
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
      aliases: ["alias-a"],
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

  test("rejects link with non-existent 'from' node — NODE_NOT_FOUND, no write", async () => {
    await seedTwoNodes();
    const r = (await client.callTool({
      name: "link",
      arguments: {
        from: "auth/missing",
        to: "auth/b",
        kind: "depends_on",
      },
    })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
      structuredContent?: { ok: boolean; error?: { code: string } };
    };
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.ok).toBe(false);
    expect(r.structuredContent?.error?.code).toBe("NODE_NOT_FOUND");

    // Nothing written
    const { GraphStore } = await import("../../src/graph.js");
    const verify = await GraphStore.load(tmpRoot);
    expect(Object.keys(verify._data().edges)).toHaveLength(0);
  });

  test("rejects link with non-existent 'to' node — NODE_NOT_FOUND, no write", async () => {
    await seedTwoNodes();
    const r = (await client.callTool({
      name: "link",
      arguments: {
        from: "auth/a",
        to: "auth/never",
        kind: "depends_on",
      },
    })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
      structuredContent?: {
        ok: boolean;
        error?: { code: string; message: string };
      };
    };
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error?.code).toBe("NODE_NOT_FOUND");
    expect(r.structuredContent?.error?.message).toContain("auth/never");

    const { GraphStore } = await import("../../src/graph.js");
    const verify = await GraphStore.load(tmpRoot);
    expect(Object.keys(verify._data().edges)).toHaveLength(0);
  });

  test("resolves alias inputs to canonical ids when writing the edge", async () => {
    await seedTwoNodes();
    const r = (await client.callTool({
      name: "link",
      arguments: {
        from: "alias-a", // alias of auth/a
        to: "auth/b",
        kind: "depends_on",
        note: "via alias",
      },
    })) as {
      isError?: boolean;
      structuredContent?: { ok: boolean; from: string; to: string };
    };
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.from).toBe("auth/a");
    expect(r.structuredContent?.to).toBe("auth/b");

    // Edge stored under the canonical id, not the alias
    const { GraphStore } = await import("../../src/graph.js");
    const verify = await GraphStore.load(tmpRoot);
    expect(verify._data().edges["auth/a|auth/b|depends_on"]).toBeDefined();
    expect(verify._data().edges["alias-a|auth/b|depends_on"]).toBeUndefined();
  });
});

// =============================================================
// structuredContent presence
// =============================================================

describe("MCP server — structuredContent on all tools", () => {
  test("query_context returns structuredContent with graph + source", async () => {
    const r = (await client.callTool({
      name: "query_context",
      arguments: { question: "anything", refresh_index: "never" },
    })) as {
      structuredContent?: {
        graph?: { nodes?: unknown[] };
        source?: { status?: unknown };
      };
    };
    expect(r.structuredContent).toBeDefined();
    expect(Array.isArray(r.structuredContent?.graph?.nodes)).toBe(true);
    expect(r.structuredContent?.source?.status).toBeDefined();
  });

  test("query_graph returns structuredContent with nodes + edges", async () => {
    const r = (await client.callTool({
      name: "query_graph",
      arguments: { question: "anything" },
    })) as {
      structuredContent?: { nodes?: unknown[]; edges?: unknown[] };
    };
    expect(r.structuredContent).toBeDefined();
    expect(Array.isArray(r.structuredContent?.nodes)).toBe(true);
    expect(Array.isArray(r.structuredContent?.edges)).toBe(true);
  });

  test("get_node returns structuredContent with node:null on miss", async () => {
    const r = (await client.callTool({
      name: "get_node",
      arguments: { id: "does/not/exist" },
    })) as { structuredContent?: { node?: unknown } };
    expect(r.structuredContent).toBeDefined();
    expect(r.structuredContent?.node).toBeNull();
  });

  test("set_active_topic returns structuredContent with ok + autoCreated", async () => {
    const r = (await client.callTool({
      name: "set_active_topic",
      arguments: { name: "fresh" },
    })) as { structuredContent?: { ok?: boolean; autoCreated?: boolean } };
    expect(r.structuredContent?.ok).toBe(true);
    expect(r.structuredContent?.autoCreated).toBe(true);
  });
});

// =============================================================
// emit_node — task-014 (collision-aware writes + per-turn cap)
// =============================================================

describe("MCP server — emit_node", () => {
  function emitArgs(overrides: Record<string, unknown>) {
    return {
      kind: "invariant",
      summary: "test summary",
      sources: [
        {
          file_path: "src/x.ts",
          line_range: [1, 10] as [number, number],
          content_hash: seededFileHash("src/x.ts"),
        },
      ],
      tags: [],
      aliases: [],
      confidence: 0.9,
      last_verified_at: "2026-04-28T00:00:00Z",
      ...overrides,
    };
  }

  // task-019 / v0.1.2 — Greptile P1 (PR #16 review): the original Date.parse-
  // only guard accepted values that the storage z.iso.datetime() rejects on
  // load, silently corrupting the graph. The handler now combines an
  // ISO-8601-UTC regex with Date.parse to match z.iso.datetime() strictness
  // exactly. These tests pin both Greptile's named cases plus the offset and
  // calendar-impossible edges.
  describe("last_verified_at runtime validation", () => {
    test.each([
      // [label, value]
      ["date-only string", "2026-05-01"],
      ["locale-style string", "May 1 2026 12:00:00 GMT"],
      ["missing trailing Z", "2026-05-01T12:00:00"],
      [
        "numeric offset (z.iso.datetime default rejects)",
        "2026-05-01T12:00:00+05:00",
      ],
      ["calendar-impossible date", "2026-13-45T12:00:00Z"],
      ["empty string", ""],
      ["garbage", "not a date"],
    ])("rejects %s with INVALID_TIMESTAMP", async (_label, value) => {
      await client.callTool({
        name: "set_active_topic",
        arguments: { name: "ts-test" },
      });
      const r = (await client.callTool({
        name: "emit_node",
        arguments: emitArgs({
          id: "ts/x",
          name: "ts test",
          last_verified_at: value,
        }),
      })) as {
        isError?: boolean;
        structuredContent?: { ok: boolean; error?: { code: string } };
      };
      expect(r.isError).toBe(true);
      expect(r.structuredContent?.ok).toBe(false);
      expect(r.structuredContent?.error?.code).toBe("INVALID_TIMESTAMP");
    });

    test.each([
      ["full second-precision Zulu", "2026-05-01T12:00:00Z"],
      ["fractional seconds", "2026-05-01T12:00:00.123Z"],
      ["minute-precision Zulu (no seconds)", "2026-05-01T12:00Z"],
    ])("accepts %s", async (_label, value) => {
      await client.callTool({
        name: "set_active_topic",
        arguments: { name: "ts-test" },
      });
      const r = (await client.callTool({
        name: "emit_node",
        arguments: emitArgs({
          id: `ts/${value.replace(/[^a-z0-9]/gi, "-")}`,
          name: "ts ok",
          last_verified_at: value,
        }),
      })) as {
        isError?: boolean;
        structuredContent?: { ok: boolean };
      };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent?.ok).toBe(true);
    });

    test("rejects timestamps more than five minutes in the future", async () => {
      await client.callTool({
        name: "set_active_topic",
        arguments: { name: "ts-test" },
      });
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const r = (await client.callTool({
        name: "emit_node",
        arguments: emitArgs({
          id: "ts/future",
          name: "future timestamp",
          last_verified_at: future,
        }),
      })) as {
        isError?: boolean;
        structuredContent?: {
          ok: boolean;
          error?: { code: string; message: string };
        };
      };
      expect(r.isError).toBe(true);
      expect(r.structuredContent?.ok).toBe(false);
      expect(r.structuredContent?.error?.code).toBe("INVALID_TIMESTAMP");
      expect(r.structuredContent?.error?.message).toContain("future");
    });
  });

  describe("source runtime validation", () => {
    test.each([
      ["empty source list", []],
      ["absolute path", "ABSOLUTE_SOURCE"],
      [
        "path escaping repo root",
        [
          {
            file_path: "../outside.ts",
            line_range: [1, 1] as [number, number],
            content_hash: "sha256:placeholder",
          },
        ],
      ],
      [
        "missing repo-relative file",
        [
          {
            file_path: "src/missing.ts",
            line_range: [1, 1] as [number, number],
            content_hash: "sha256:placeholder",
          },
        ],
      ],
      [
        "external documentation URL",
        [
          {
            file_path: "https://nextjs.org/docs",
            line_range: [1, 1] as [number, number],
            content_hash: "sha256:placeholder",
          },
        ],
      ],
    ])("rejects %s with INVALID_SOURCE", async (_label, sources) => {
      await client.callTool({
        name: "set_active_topic",
        arguments: { name: "source-test" },
      });
      const sourceArgs =
        sources === "ABSOLUTE_SOURCE"
          ? [
              {
                file_path: path.join(tmpRoot, "src/x.ts"),
                line_range: [1, 1] as [number, number],
                content_hash: "sha256:placeholder",
              },
            ]
          : sources;
      const r = (await client.callTool({
        name: "emit_node",
        arguments: emitArgs({
          id: "source/bad",
          name: "Bad source",
          sources: sourceArgs,
        }),
      })) as {
        isError?: boolean;
        structuredContent?: { ok: boolean; error?: { code: string } };
      };

      expect(r.isError).toBe(true);
      expect(r.structuredContent?.ok).toBe(false);
      expect(r.structuredContent?.error?.code).toBe("INVALID_SOURCE");

      const { GraphStore } = await import("../../src/graph.js");
      const verify = await GraphStore.load(tmpRoot);
      expect(verify.getNode("source/bad")).toBeNull();
    });

    test("rejects source hashes that do not match current file content", async () => {
      await client.callTool({
        name: "set_active_topic",
        arguments: { name: "source-test" },
      });
      const r = (await client.callTool({
        name: "emit_node",
        arguments: emitArgs({
          id: "source/hash-mismatch",
          name: "Hash mismatch",
          sources: [
            {
              file_path: "src/x.ts",
              line_range: [1, 1],
              content_hash:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        }),
      })) as {
        isError?: boolean;
        structuredContent?: {
          ok: boolean;
          error?: { code: string; message: string };
        };
      };

      expect(r.isError).toBe(true);
      expect(r.structuredContent?.ok).toBe(false);
      expect(r.structuredContent?.error?.code).toBe("INVALID_SOURCE");
      expect(r.structuredContent?.error?.message).toContain("content_hash");

      const { GraphStore } = await import("../../src/graph.js");
      const verify = await GraphStore.load(tmpRoot);
      expect(verify.getNode("source/hash-mismatch")).toBeNull();
    });
  });

  test("creates a fresh node and registers the active topic in tags", async () => {
    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "auth" },
    });
    const r = (await client.callTool({
      name: "emit_node",
      arguments: emitArgs({
        id: "auth/middleware",
        name: "Auth middleware",
      }),
    })) as {
      structuredContent?: { ok: boolean; createdId: string; merged: boolean };
    };
    expect(r.structuredContent?.ok).toBe(true);
    expect(r.structuredContent?.merged).toBe(false);
    expect(r.structuredContent?.createdId).toBe("auth/middleware");

    const get = (await client.callTool({
      name: "get_node",
      arguments: { id: "auth/middleware" },
    })) as { structuredContent?: { node: { tags: string[] } | null } };
    expect(get.structuredContent?.node?.tags).toContain("auth");
  });

  test("fills range_hash on accepted source anchors", async () => {
    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "anchors" },
    });
    const r = (await client.callTool({
      name: "emit_node",
      arguments: emitArgs({
        id: "anchors/range-hash",
        name: "Range hash",
      }),
    })) as {
      structuredContent?: { ok: boolean; createdId: string; merged: boolean };
    };
    expect(r.structuredContent?.ok).toBe(true);

    const get = (await client.callTool({
      name: "get_node",
      arguments: { id: "anchors/range-hash" },
    })) as {
      structuredContent?: {
        node: { sources: Array<{ range_hash?: string }> } | null;
      };
    };
    expect(get.structuredContent?.node?.sources[0]?.range_hash).toMatch(
      /^sha256:/,
    );
  });

  test("collision response (D1): returns ok:false collision:true with candidates, no write", async () => {
    // Seed a node similar to what we'll emit.
    const { GraphStore } = await import("../../src/graph.js");
    const seeded = await GraphStore.load(tmpRoot);
    seeded.upsertNode({
      id: "messaging/sms-sender",
      kind: "integration",
      name: "SMS sender via Twilio",
      summary: "Sends SMS via Twilio.",
      sources: [
        {
          file_path: "src/messaging/twilio.ts",
          line_range: [1, 40],
          content_hash: "sha256:placeholder",
        },
      ],
      tags: ["messaging"],
      aliases: [],
      status: "active",
      confidence: 0.95,
      last_verified_at: "2026-04-28T00:00:00Z",
    });
    await seeded.save();

    const r = (await client.callTool({
      name: "emit_node",
      arguments: emitArgs({
        id: "messaging/sms-client",
        kind: "integration",
        name: "SMS client wrapper",
        summary: "Wraps Twilio with retry.",
        sources: [
          {
            file_path: "src/messaging/twilio.ts",
            line_range: [42, 80],
            content_hash: seededFileHash("src/messaging/twilio.ts"),
          },
        ],
        tags: ["messaging"],
      }),
    })) as {
      isError?: boolean;
      structuredContent?: {
        ok: boolean;
        collision: boolean;
        candidates: {
          id: string;
          kind: string;
          name: string;
          summary: string;
          similarity: number;
        }[];
        next_action: string;
      };
    };
    // D1: collision is NOT an isError — it's a flow-control response.
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.ok).toBe(false);
    expect(r.structuredContent?.collision).toBe(true);
    expect(r.structuredContent?.candidates.map((c) => c.id)).toContain(
      "messaging/sms-sender",
    );
    expect(r.structuredContent?.candidates[0]).toEqual(
      expect.objectContaining({
        id: "messaging/sms-sender",
        kind: "integration",
        name: "SMS sender via Twilio",
        summary: "Sends SMS via Twilio.",
      }),
    );
    expect(r.structuredContent?.next_action).toContain("merge_with");

    // Crucially: no write
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("messaging/sms-client")).toBeNull();
  });

  test("merge_with: merges into target id, skips collision check", async () => {
    const { GraphStore } = await import("../../src/graph.js");
    const seeded = await GraphStore.load(tmpRoot);
    seeded.upsertNode({
      id: "auth/middleware",
      kind: "invariant",
      name: "Auth middleware",
      summary: "Original.",
      sources: [
        {
          file_path: "x.ts",
          line_range: [1, 10],
          content_hash: "sha256:placeholder",
        },
      ],
      tags: ["auth"],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: "2026-01-01T00:00:00Z",
    });
    await seeded.save();

    const r = (await client.callTool({
      name: "emit_node",
      arguments: emitArgs({
        id: "auth/incoming",
        kind: "invariant",
        name: "Auth middleware",
        summary: "Updated.",
        confidence: 0.95,
        merge_with: "auth/middleware",
      }),
    })) as {
      structuredContent?: { ok: boolean; merged: boolean; createdId: string };
    };
    expect(r.structuredContent?.ok).toBe(true);
    expect(r.structuredContent?.merged).toBe(true);
    expect(r.structuredContent?.createdId).toBe("auth/middleware");

    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("auth/middleware")?.summary).toBe("Updated.");
    expect(verify.getNode("auth/incoming")).toBeNull();
  });

  test("merge_with on missing target → NODE_NOT_FOUND error, no write", async () => {
    const r = (await client.callTool({
      name: "emit_node",
      arguments: emitArgs({
        id: "auth/incoming",
        name: "Anything",
        merge_with: "auth/never",
      }),
    })) as {
      isError?: boolean;
      structuredContent?: { ok: boolean; error?: { code: string } };
    };
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error?.code).toBe("NODE_NOT_FOUND");

    const { GraphStore } = await import("../../src/graph.js");
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("auth/incoming")).toBeNull();
  });

  test("force_new (D2): creates despite collision; reason is prepended to summary", async () => {
    const { GraphStore } = await import("../../src/graph.js");
    const seeded = await GraphStore.load(tmpRoot);
    seeded.upsertNode({
      id: "messaging/sms-sender",
      kind: "integration",
      name: "SMS sender via Twilio",
      summary: "x",
      sources: [
        {
          file_path: "src/messaging/twilio.ts",
          line_range: [1, 40],
          content_hash: "sha256:placeholder",
        },
      ],
      tags: ["messaging"],
      aliases: [],
      status: "active",
      confidence: 0.95,
      last_verified_at: "2026-04-28T00:00:00Z",
    });
    await seeded.save();

    const r = (await client.callTool({
      name: "emit_node",
      arguments: emitArgs({
        id: "messaging/sms-client",
        kind: "integration",
        name: "SMS client wrapper",
        summary: "Wraps Twilio with retry.",
        sources: [
          {
            file_path: "src/messaging/twilio.ts",
            line_range: [42, 80],
            content_hash: seededFileHash("src/messaging/twilio.ts"),
          },
        ],
        tags: ["messaging"],
        force_new: { reason: "structurally distinct from sms-sender" },
      }),
    })) as { structuredContent?: { ok: boolean; createdId: string } };
    expect(r.structuredContent?.ok).toBe(true);
    expect(r.structuredContent?.createdId).toBe("messaging/sms-client");

    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("messaging/sms-client")?.summary).toMatch(
      /^\[force_new: structurally distinct from sms-sender\]/,
    );
  });

  test("merge_with + force_new together → INVALID_FLAGS error", async () => {
    const r = (await client.callTool({
      name: "emit_node",
      arguments: emitArgs({
        id: "auth/x",
        name: "Auth x",
        merge_with: "auth/anything",
        force_new: { reason: "test" },
      }),
    })) as {
      isError?: boolean;
      structuredContent?: { ok: boolean; error?: { code: string } };
    };
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error?.code).toBe("INVALID_FLAGS");
  });

  test("rejects confidence > 1 via input schema", async () => {
    const r = (await client.callTool({
      name: "emit_node",
      arguments: emitArgs({
        id: "auth/x",
        name: "Auth x",
        confidence: 1.5,
      }),
    })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });
});

// =============================================================
// Per-turn cap
// =============================================================

describe("MCP server — per-turn emission cap", () => {
  function uniqueArgs(i: number) {
    return {
      id: `cap/n${i}`,
      kind: "invariant",
      name: `Distinct node ${i}`,
      summary: `unique enough — bigram pattern ${i}`,
      sources: [
        {
          file_path: `src/cap-${i}.ts`,
          line_range: [1, 10] as [number, number],
          content_hash: seededFileHash(`src/cap-${i}.ts`),
        },
      ],
      tags: [`cap-${i}`],
      aliases: [],
      confidence: 0.9,
      last_verified_at: "2026-04-28T00:00:00Z",
    };
  }

  test("5 emissions accepted; 6th returns capped, no write", async () => {
    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "cap-test" },
    });

    for (let i = 0; i < 5; i++) {
      const r = (await client.callTool({
        name: "emit_node",
        arguments: uniqueArgs(i),
      })) as { structuredContent?: { ok: boolean } };
      expect(r.structuredContent?.ok).toBe(true);
    }

    // 6th call hits the cap
    const r = (await client.callTool({
      name: "emit_node",
      arguments: uniqueArgs(5),
    })) as {
      isError?: boolean;
      structuredContent?: { ok: boolean; capped: boolean };
    };
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.capped).toBe(true);

    const { GraphStore } = await import("../../src/graph.js");
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("cap/n5")).toBeNull();
    expect(Object.keys(verify._data().nodes)).toHaveLength(5);
  });

  test("set_active_topic resets the counter — emissions after the reset proceed", async () => {
    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "cap-test" },
    });
    for (let i = 0; i < 5; i++) {
      await client.callTool({ name: "emit_node", arguments: uniqueArgs(i) });
    }

    // Reset
    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "cap-test-2" },
    });

    // 6th overall, but 1st in the new turn — should succeed
    const r = (await client.callTool({
      name: "emit_node",
      arguments: uniqueArgs(5),
    })) as { structuredContent?: { ok: boolean } };
    expect(r.structuredContent?.ok).toBe(true);
  });

  test("collision response does NOT count toward the cap", async () => {
    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "cap-collision" },
    });
    // Seed a node that will trigger collision on the next call
    const { GraphStore } = await import("../../src/graph.js");
    const seeded = await GraphStore.load(tmpRoot);
    seeded.upsertNode({
      id: "messaging/sms-sender",
      kind: "integration",
      name: "SMS sender via Twilio",
      summary: "x",
      sources: [
        {
          file_path: "src/messaging/twilio.ts",
          line_range: [1, 40],
          content_hash: "sha256:placeholder",
        },
      ],
      tags: ["messaging"],
      aliases: [],
      status: "active",
      confidence: 0.95,
      last_verified_at: "2026-04-28T00:00:00Z",
    });
    await seeded.save();

    // Issue 5 collision-triggering calls (no force_new); none should write,
    // so the counter stays at 0.
    for (let i = 0; i < 5; i++) {
      await client.callTool({
        name: "emit_node",
        arguments: {
          id: `messaging/sms-client-${i}`,
          kind: "integration",
          name: "SMS client wrapper",
          summary: "x",
          sources: [
            {
              file_path: "src/messaging/twilio.ts",
              line_range: [42, 80],
              content_hash: seededFileHash("src/messaging/twilio.ts"),
            },
          ],
          tags: ["messaging"],
          aliases: [],
          confidence: 0.9,
          last_verified_at: "2026-04-28T00:00:00Z",
        },
      });
    }

    // A 6th, non-colliding call should still succeed (counter never advanced).
    const r = (await client.callTool({
      name: "emit_node",
      arguments: {
        id: "auth/distinct",
        kind: "invariant",
        name: "completely distinct from messaging",
        summary: "unrelated",
        sources: [
          {
            file_path: "src/auth/distinct.ts",
            line_range: [1, 10],
            content_hash: seededFileHash("src/auth/distinct.ts"),
          },
        ],
        tags: ["auth"],
        aliases: [],
        confidence: 0.9,
        last_verified_at: "2026-04-28T00:00:00Z",
      },
    })) as { structuredContent?: { ok: boolean } };
    expect(r.structuredContent?.ok).toBe(true);
  });
});

// =============================================================
// Telemetry wiring (task-016) — end-to-end
// =============================================================

describe("MCP server — metrics wiring", () => {
  test("set_active_topic + query + emit + link → metrics.json reflects all", async () => {
    delete process.env.CODEMAP_TELEMETRY;
    delete process.env.DO_NOT_TRACK;

    await client.callTool({
      name: "set_active_topic",
      arguments: { name: "telemetry-test" },
    });
    await client.callTool({
      name: "query_graph",
      arguments: { question: "anything" },
    });
    await client.callTool({
      name: "emit_node",
      arguments: {
        id: "tele/x",
        kind: "invariant",
        name: "Distinct telemetry node",
        summary: "x",
        sources: [
          {
            file_path: "src/x.ts",
            line_range: [1, 10],
            content_hash: seededFileHash("src/x.ts"),
          },
        ],
        tags: [],
        aliases: [],
        confidence: 0.9,
        last_verified_at: "2026-04-28T00:00:00Z",
      },
    });
    await client.callTool({
      name: "emit_node",
      arguments: {
        id: "tele/y",
        kind: "invariant",
        name: "Another telemetry node",
        summary: "y",
        sources: [
          {
            file_path: "src/y.ts",
            line_range: [1, 10],
            content_hash: seededFileHash("src/y.ts"),
          },
        ],
        tags: [],
        aliases: [],
        confidence: 0.9,
        last_verified_at: "2026-04-28T00:00:00Z",
      },
    });
    await client.callTool({
      name: "link",
      arguments: {
        from: "tele/x",
        to: "tele/y",
        kind: "depends_on",
      },
    });

    const { MetricsStore } = await import("../../src/metrics.js");
    const m = (await MetricsStore.load(tmpRoot))!;
    expect(m).not.toBeNull();
    const head = m._data().per_turn[0]!;
    expect(head.topic).toBe("telemetry-test");
    expect(head.queries).toBe(1);
    expect(head.nodes_emitted).toBe(2);
    expect(head.links_made).toBe(1);
    expect(head.cap_hit).toBe(false);
  });

  test("CODEMAP_TELEMETRY=false: tools succeed but no metrics.json written", async () => {
    process.env.CODEMAP_TELEMETRY = "false";
    try {
      await client.callTool({
        name: "set_active_topic",
        arguments: { name: "no-telemetry" },
      });
      await client.callTool({
        name: "query_graph",
        arguments: { question: "x" },
      });
      const { promises: _fs } = await import("node:fs");
      const { join: _join } = await import("node:path");
      await expect(
        _fs.stat(_join(tmpRoot, ".codemap", "metrics.json")),
      ).rejects.toThrow();
    } finally {
      delete process.env.CODEMAP_TELEMETRY;
    }
  });
});
