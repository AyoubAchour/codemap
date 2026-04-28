# Codemap — Technical Specification

> Companion to `V1_SPEC.md`. V1_SPEC defines *what* we're building and *why*; this document defines *how*.

## 1. Stack at a glance


| Layer             | Choice                                                            | Reason                                                                               |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Runtime           | Bun (primary) + Node 22+ (first-class fallback)                   | Sub-100 ms cold start with Bun; Node kept first-class because Bun has WSL2 path quirks and not every user installs it. CI runs both. |
| Language          | TypeScript                                                        | Reference MCP SDK; type safety; same language for v2 viewer                          |
| MCP SDK           | `@modelcontextprotocol/sdk`                                       | Official reference; most spec-current                                                |
| Schema validation | `zod`                                                             | Runtime validation + auto-derived JSON Schema for MCP tool definitions               |
| String similarity | `fastest-levenshtein` (+ Dice coefficient)                        | For collision detection; ~5× faster than naive Levenshtein                           |
| Hashing           | `node:crypto` (built-in)                                          | SHA-256 for `content_hash`                                                           |
| File I/O          | `node:fs/promises` (built-in)                                     | Atomic writes via temp + `rename`                                                    |
| Concurrency       | `proper-lockfile`                                                 | Short-held file lock for safe concurrent multi-process writers; see §3.4             |
| CLI               | `commander`                                                       | Lightweight, mature; for `codemap show / correct / deprecate / validate`             |
| Tests             | `bun test` (built-in)                                             | Fast; integration tests can drive the MCP server via JSON-RPC                        |
| Distribution      | `npm publish` (primary) + `bun build --compile` (binary fallback) | `npx -y @your-org/codemap-mcp` for primary install                                   |


Performance benchmarks ([TM Dev Lab v2](https://www.tmdevlab.com/mcp-server-performance-benchmark-v2.html)) confirm: at our load (≤500 calls/dev/day), TS+Bun comfortably handles all hot paths in <50 ms. Picking Rust or Go would buy nothing measurable while costing weeks of iteration time.

## 2. Project layout

```
codemap/
├── src/
│   ├── index.ts              # MCP server: registers 5 tools, starts stdio transport
│   ├── graph.ts              # GraphStore: load / save / validate; atomic write
│   ├── collision.ts          # Similarity scoring + collision detection
│   ├── metrics.ts            # Telemetry to .codemap/metrics.json
│   ├── tools/
│   │   ├── query_graph.ts
│   │   ├── get_node.ts
│   │   ├── emit_node.ts      # Calls collision.ts before creating new id
│   │   ├── link.ts
│   │   └── set_active_topic.ts
│   ├── cli/
│   │   ├── show.ts
│   │   ├── correct.ts
│   │   ├── deprecate.ts
│   │   ├── validate.ts
│   │   └── rollup.ts
│   ├── schema.ts             # zod schemas: Node, Edge, GraphFile
│   └── types.ts              # TS types derived from zod schemas
├── test/
│   ├── unit/                 # graph, collision, validator
│   └── integration/          # end-to-end via spawned MCP client
├── fixtures/                 # sample graph.json files for tests
├── bin/
│   ├── codemap.ts            # CLI entry
│   └── codemap-mcp.ts        # MCP server entry
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

## 3. Data layer

### 3.1 Schemas (zod)

```ts
import { z } from "zod";

export const SourceRefSchema = z.object({
  file_path: z.string(),                       // relative to repo_root
  line_range: z.tuple([z.number(), z.number()]),
  content_hash: z.string().regex(/^sha256:/),
});

export const NodeKindSchema = z.enum([
  "file", "symbol", "package",         // syntactic / structural
  "integration", "concept", "flow",    // conceptual
  "decision", "invariant", "gotcha",   // knowledge (highest value)
]);

export const NodeSchema = z.object({
  id: z.string().min(1),
  kind: NodeKindSchema,
  name: z.string().min(1),
  summary: z.string(),
  sources: z.array(SourceRefSchema),
  tags: z.array(z.string()),
  aliases: z.array(z.string()).default([]),
  status: z.enum(["active", "deprecated"]).default("active"),
  confidence: z.number().min(0).max(1),
  last_verified_at: z.string().datetime(),
});

export const EdgeKindSchema = z.enum([
  "imports", "calls", "depends_on", "implements", "replaces", "contradicts",
  "derived_from", "mirrors",
]);

export const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: EdgeKindSchema,
  note: z.string().optional(),
});

export const GraphFileSchema = z.object({
  version: z.literal(1),
  created_at: z.string().datetime(),
  topics: z.record(z.string(), z.object({
    created_at: z.string().datetime(),
    auto_created: z.boolean(),
  })),
  nodes: z.record(z.string(), NodeSchema.omit({ id: true })),
  edges: z.record(z.string(), z.object({
    note: z.string().optional(),
  })),
});
```

Storage detail: edge keys are `"from|to|kind"`, node keys are `id`. Topics, nodes, and edges all use keyed maps (not arrays) for clean git merges.

### 3.2 Graph store contract (graph.ts)

```ts
class GraphStore {
  static async load(repoRoot: string): Promise<GraphStore>;

  // Read APIs
  query(question: string, limit?: number): { nodes: Node[]; edges: Edge[] };
  getNode(id: string): Node | null;             // resolves through aliases

  // Write APIs (mutate in-memory; caller invokes save())
  upsertNode(node: Node, opts: { activeTopic?: string }): { merged: boolean };
  ensureEdge(from: string, to: string, kind: EdgeKind, note?: string): void;
  ensureTopic(name: string): void;

  // Persistence
  async save(): Promise<void>;                  // atomic temp+rename
  validate(): ValidationResult;                 // runs on load
}
```

Atomic write:

```ts
async save() {
  const path = `${this.repoRoot}/.codemap/graph.json`;
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, this.serialize());
  // fsync where possible; fall back gracefully on platforms that don't support it
  await fs.rename(tmp, path);
}
```

### 3.3 Validator

Runs on every `GraphStore.load()`:

1. **Schema check** (zod). If schema fails, refuse to load and emit a diff-style report. CLI exits code 2; MCP server logs to stderr.
2. **Dangling edges:** for every edge key `from|to|kind`, both `from` and `to` must exist in `nodes`. Drop offending edges; record to telemetry.
3. **Alias uniqueness:** the same alias on multiple node IDs is a warning, not a fail. User must resolve via `codemap correct`.
4. **Topic coverage:** every node tag matching a topic name should have an entry in `topics`; auto-fill when missing.

Repairs are applied in-memory and persisted on the next `save()`.

### 3.4 Concurrency model

V1 supports **multiple concurrent readers** and **multiple concurrent writers** against the same `graph.json`. Multiple agent processes (e.g. two Claude Code sessions, or a Claude Code session plus a `codemap` CLI invocation) can run safely.

- **Readers are always safe.** The atomic write pattern in §3.2 (write to `.tmp`, then `rename`) means readers always observe either the previous complete file or the new complete file — never a torn write. No coordination is needed for read-only operations (`query_graph`, `get_node`, CLI `show`).
- **Writers serialize via `proper-lockfile`.** The lock is held only during the write critical section (~50 ms), not for the lifetime of the process:

```ts
import { lock } from "proper-lockfile";

async save() {
  const release = await lock(this.path, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,  // 10 s — lib's built-in stale-lock recovery
  });
  try {
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, this.serialize());
    await fs.rename(tmp, this.path);
  } finally {
    await release();
  }
}
```

If a write can't acquire the lock within ~5 retries (≤500 ms total), the MCP tool returns `{ ok: false, error: { code: "lock_timeout" } }` and the agent retries on its next turn. In practice this should be exceedingly rare given a ~50 ms critical section.

**Why a lockfile here when V1_SPEC §15 originally said "no lockfile":** the original "no lockfile" stance was based on a single-writer assumption. The user explicitly required concurrent writer support, which means coordination is unavoidable. `proper-lockfile`'s built-in stale detection (10 s default) addresses the original concern about wedged tools after a crash.

## 4. Collision detection (collision.ts)

`emit_node` calls `findCollisions(incoming, existing[])` before creating a new `id`. Algorithm:

```
For each existing node N (skip if N.id === incoming.id):
  score = max(
    name_similarity(incoming.name, N.name)              [weight 0.4],
    name_similarity(incoming.name, alias)               for alias in N.aliases,
    source_overlap(incoming.sources, N.sources)         [weight 0.3],
    tag_overlap(incoming.tags, N.tags)                  [weight 0.3],
  )
  if score >= COLLISION_THRESHOLD: append { id: N.id, score }
Return top 3 candidates by score
```

Where:

- `name_similarity` = Dice coefficient on character bigrams (handles short strings well; falls back to normalized Levenshtein).
- `source_overlap` = Jaccard similarity over the set of `file_path` values, plus a small bonus when line ranges overlap.
- `tag_overlap` = Jaccard over tag sets.

`COLLISION_THRESHOLD` defaults to **0.65**, configurable via env var `CODEMAP_COLLISION_THRESHOLD`. The threshold is a starting guess; M1 / M2 will tune it against real cases.

When candidates are non-empty, the server returns:

```json
{
  "ok": false,
  "collision": true,
  "candidates": [
    { "id": "payment/checkout", "name": "Checkout flow", "similarity": 0.87 }
  ],
  "next_action": "re-call emit_node with merge_with: <id> OR force_new: true with reason: <string>"
}
```

The agent must re-call with `merge_with` or `force_new(reason)` — the server will not silently create a duplicate.

## 5. MCP tools

All tools defined via the MCP SDK's `registerTool(name, config, handler)` API with zod-derived JSON Schema. (The older `server.tool(...)` overloads in `@modelcontextprotocol/sdk` ≥1.x are deprecated; we use `registerTool` everywhere.)

```ts
server.registerTool(
  "query_graph",
  {
    title: "Query graph",
    description:
      "Find nodes relevant to a task description. Call before planning any task that involves understanding this codebase.",
    inputSchema: z.object({
      question: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional().default(10),
    }),
    outputSchema: z.object({
      nodes: z.array(NodeSchema),
      edges: z.array(EdgeSchema),
    }),
  },
  async ({ question, limit }) => {
    const store = await GraphStore.load(repoRoot);
    const result = store.query(question, limit);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  },
);
```

**Per-turn emission cap.** In-memory counter, **reset on every `set_active_topic` call**. After 5 successful `emit_node` calls since the last `set_active_topic`, further calls return `{ ok: false, capped: true }`.

No timeout / heuristic — the counter is purely tied to `set_active_topic`. The instruction document already requires the agent to call `set_active_topic` at task start, which is exactly the boundary we want for the cap. If the agent doesn't call it, that's a misuse the cap can't fix; the answer is to tighten the instruction document.

**Why not use MCP session IDs.** The MCP spec ([2025-06-18 transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)) defines `Mcp-Session-Id` headers for the **Streamable HTTP** transport, but stdio (which v1 uses) has no equivalent — the process lifetime *is* the session. There is an active proposal ([SEP-1359](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1359)) for transport-independent protocol-level sessions, but it's not finalized. When v1 adds HTTP transport, we'll switch the cap-counter scope to `Mcp-Session-Id`. Until then, `set_active_topic` is our turn boundary.

## 6. Stdio transport

V1 uses stdio only. HTTP/SSE deferred to v2 (only needed for hosted / multi-tenant scenarios).

`bin/codemap-mcp.ts`:

```ts
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "../src/index.js";

const server = new Server(
  { name: "codemap", version: "0.1.0" },
  { capabilities: { tools: {} } }
);
await registerTools(server, { repoRoot: process.cwd() });
await server.connect(new StdioServerTransport());
```

Claude Code config (`~/.config/claude-code/mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "codemap": {
      "command": "npx",
      "args": ["-y", "@your-org/codemap-mcp"]
    }
  }
}
```

## 7. Telemetry (metrics.json)

Light counters written to `.codemap/metrics.json` (committed to git for team-wide ROI visibility):

```json
{
  "version": 1,
  "per_turn": [
    {
      "topic": "auth-bugfix",
      "ts": "2026-04-29T12:34:56Z",
      "queries": 1,
      "results_returned": 4,
      "nodes_emitted": 3,
      "collisions_detected": 1,
      "cap_hit": false,
      "stale_rechecks": 1
    }
  ],
  "rollup_weekly": [
    {
      "week_of": "2026-04-26",
      "total_nodes": 47,
      "verified_pct_7d": 0.62,
      "knowledge_kind_ratio": 0.34
    }
  ]
}
```

Per-turn entries are appended live. The rollup is computed by `codemap rollup` (manual) or lazily on the first `query_graph` call after a week boundary.

## 8. CLI

```
codemap show <id>                          print one node + its edges
codemap correct <id> --field <k> --value <v>
codemap deprecate <id> [--reason <r>]
codemap validate                           dry-run validator; exit 0 if clean
codemap rollup                             compute weekly metrics rollup
```

The CLI shares the `GraphStore` class with the MCP server — same load / validate / save logic. CLI invocations do **not** count toward the per-turn emission cap (different process, different counter scope).

## 9. Error handling

- All MCP tool errors return `{ ok: false, error: { code, message } }` rather than throwing — the MCP SDK surfaces these cleanly to the agent.
- Schema validation errors during load → CLI exits with code 2 and a diff-style report; MCP server logs to stderr so Claude Code surfaces it.
- Atomic write fails → temp file remains on disk; next `load()` detects, warns, removes it.
- Tunable thresholds are env-driven (`CODEMAP_COLLISION_THRESHOLD`, `CODEMAP_PER_TURN_CAP`) so M1/M2 iteration doesn't require redeploys.

## 10. Testing strategy

- **Unit tests** (`bun test`): graph store CRUD, collision scoring on fixture pairs, validator on malformed JSON, atomic-write behavior under simulated crash.
- **Integration tests:** spawn the compiled MCP server in stdio mode; drive it by hand-crafted JSON-RPC; assert tool responses on every tool path.
- **Fixture corpus:** ~15 hand-built `graph.json` fixtures: empty, small, with-aliases, with-collision-pairs, with-deprecated, malformed-schema, dangling-edges, oversize.
- **M1 manual test:** `graph.json` Claude can read/edit directly via its built-in file tools — used to iterate the instruction document before any TS code lands.

## 11. Performance budgets

Per MCP call, on a 1k-node graph (TS + Bun, modern laptop):


| Operation                          | Target | Hard limit |
| ---------------------------------- | ------ | ---------- |
| `query_graph`                      | <30 ms | 100 ms     |
| `get_node`                         | <5 ms  | 50 ms      |
| `emit_node` (no collision)         | <30 ms | 100 ms     |
| `emit_node` (with collision check) | <50 ms | 200 ms     |
| Atomic save                        | <30 ms | 150 ms     |


Cold start (Bun): target <200 ms from spawn to first MCP message handled.

If hard limits are exceeded in production, log to telemetry and investigate. We don't tune for performance below the hard limit.

## 12. Security

- **Untrusted graph content** (V1_SPEC §15): node summaries, notes, aliases are data-only. The MCP server does not `eval` or otherwise execute graph content. The agent reading them is the prompt-injection surface; v1 mitigation is the instruction-doc warning + reviewer expectation that PR diffs of `.codemap/graph.json` are reviewed like code.
- **Path traversal:** `file_path` values must be relative to `repo_root`. Absolute paths and `..` traversal are rejected at validation time.
- **No network:** v1 is local-only. The MCP server makes no outbound network calls.
- **No code execution:** no `eval`, no shell-out beyond `git rev-parse --show-toplevel` (read-only) for repo-root discovery.

## 13. Distribution

- **Primary:** `npm publish` → users install via `npx -y @your-org/codemap-mcp`. ~95% of target users (devs with Node 20+) get a one-line install.
- **Secondary:** GitHub releases ship single binaries built via `bun build --compile` for Linux x64, macOS arm64, Windows x64.
- **Versioning:** SemVer. Major bump on graph-schema breaks; minor on tool additions; patch on bugs.
- **Migration policy:** schema migrations are forward-compatible across at least 2 minor versions before requiring upgrade.

**Cost note.** Codemap is a free personal project. Everything in this spec sticks to free tiers: npm publishing is free for unscoped or `@user`-scoped packages; GitHub Actions has a generous free tier for public repos; GitHub releases are free; binaries are built in CI. No paid services in v1. v2 candidates that would imply paid usage (e.g. Voyage / OpenAI embeddings) are explicitly replaced with free local alternatives (Ollama + `nomic-embed-text`).

## 14. Decisions log + remaining open questions

### Decisions made (closed)

- **Concurrent reads + writers:** supported. Atomic writes for readers; `proper-lockfile` for writers (§3.4).
- **`metrics.json` in git:** committed. Small file, useful diff history, supports team-wide ROI conversations.
- **Bun-only vs Node fallback:** both supported as first-class. Bun is the recommended runtime for cold-start; Node 22+ is fully tested in CI as a fallback. Per [Bun compatibility 2026](https://dev.to/alexcloudstar/bun-compatibility-in-2026-what-actually-works-what-does-not-and-when-to-switch-23eb), Bun 1.3+ is ~98% Node-compatible but has WSL2 path quirks worth dodging.
- **Per-turn boundary:** counter reset on `set_active_topic` (no timeout heuristic). Migrates to `Mcp-Session-Id` if/when HTTP transport ships.

### Remaining open

1. **Cross-platform atomic-rename behavior.** `fs.rename` on Windows / NTFS has historically had quirks when the target file is open by another process. Verify in M2 with a Windows test.
2. **`proper-lockfile` reliability across OSes.** Library is widely used but has edge cases on network filesystems (NFS, SMB). Test in M2; document any workarounds.
3. **When to add HTTP/SSE transport.** Only worth it if v2 grows a hosted / multi-machine use case. Defer until M3 reveals demand.
4. **Embedding model for v2 retrieval.** Default plan: Ollama + `nomic-embed-text` (free, local, ~100 MB). Alternatives if quality is poor: `bge-small-en-v1.5`, `gte-small`. Decide during v2 planning, not now.

