# Task 013: MCP server skeleton + simple tools

**Status:** done
**Phase:** M2 — Sprint 2.2
**Estimate:** 3–4 hours
**Depends on:** task-007 (GraphStore), task-008 (validator)
**Blocks:** task-014 (emit_node tool — depends on this skeleton + task-012)

## Goal

Wire up the MCP server with the four "simple" tools — `query_graph`, `get_node`, `link`, `set_active_topic` — over stdio transport. `emit_node` is deliberately excluded here because it depends on the collision detector (task-012); it lands separately in task-014 with per-turn cap enforcement.

After this task: `bun build --compile bin/codemap-mcp.ts --outfile dist/codemap-mcp` produces a working binary that responds to MCP `tools/list` and the four tool calls correctly when driven over stdio.

## Context

References:

- `V1_SPEC.md` §7.1 / §7.2 / §7.4 / §7.5 — the four tool contracts.
- `TECH_SPEC.md` §5 — current draft of MCP tool wiring. **Note:** §5's example uses the old `server.tool(...)` API; the current SDK (≥1.x) uses `server.registerTool(name, config, handler)`. Update §5 in this task.
- `TECH_SPEC.md` §6 — stdio transport entry pattern.
- Installed: `@modelcontextprotocol/sdk` 1.29.0.

## ⚠ One small spec patch needed

`TECH_SPEC.md` §5 shows:

```ts
server.tool(
  "query_graph",
  "Find nodes relevant to...",
  { question: z.string(), ... },
  async ({ question, ... }) => { ... }
);
```

Current SDK pattern is:

```ts
server.registerTool(
  "query_graph",
  {
    title: "Query graph",
    description: "Find nodes relevant to...",
    inputSchema: z.object({ question: z.string(), ... }),
    outputSchema: z.object({ ... }), // optional
  },
  async ({ question, ... }) => {
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result, // optional, paired with outputSchema
    };
  }
);
```

The change is mechanical (rename + wrap schema in object), not architectural. Patch §5 in this PR.

## Deliverables

- `src/index.ts` — `registerTools(server, options)` that registers the 4 tools onto a passed-in `McpServer`. The 5th tool (`emit_node`) is task-014's deliverable.
- `src/tools/query_graph.ts`
- `src/tools/get_node.ts`
- `src/tools/link.ts`
- `src/tools/set_active_topic.ts`
- `src/tools/_active_topic.ts` (or similar) — shared in-memory state for the active topic. Module-scoped, simple `let` + getter/setter. Keeps `query_graph` etc. free of topic-tracking responsibility.
- `bin/codemap-mcp.ts` — stdio entry. Constructs `McpServer`, calls `registerTools`, connects to `StdioServerTransport`.
- `test/unit/tools.test.ts` (or split per tool) — unit tests for each tool's handler logic, called directly (no spawned process).
- `test/integration/mcp.test.ts` — end-to-end tests: spawn the compiled / `bun run`-ed server, drive it via JSON-RPC, assert responses on every tool path.
- `TECH_SPEC.md` §5 patch (registerTool API).

## API per tool

### `query_graph`

```ts
inputSchema: z.object({
  question: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional().default(10),
});
// Output: GraphStore.query() result — { nodes, edges }.
```

Calls `GraphStore.load(repoRoot).query(question, limit)`. Returns the result as both `content` text and `structuredContent`.

### `get_node`

```ts
inputSchema: z.object({
  id: z.string().min(1),
});
// Output: Node | null.
```

Calls `GraphStore.load(repoRoot).getNode(id)`. Returns `null` if no match (after alias resolution) — handler still returns success; the agent reads `null` from `structuredContent`.

### `link`

```ts
inputSchema: z.object({
  from: NodeIdSchema,
  to: NodeIdSchema,
  kind: EdgeKindSchema,
  note: z.string().optional(),
});
// Output: { ack: true }.
```

Loads the store, calls `ensureEdge`, calls `save()`. Idempotent per V1_SPEC §7.4.

### `set_active_topic`

```ts
inputSchema: z.object({
  name: z.string().min(1),
});
// Output: { ack: true, autoCreated: boolean }.
```

Loads the store, calls `ensureTopic(name)`, sets the in-memory active topic (used by `emit_node` in task-014). Saves.

## Implementation notes

- `**McpServer` lifecycle:** one server instance per process. Created in `bin/codemap-mcp.ts`, lives until stdio closes. The `repoRoot` is `process.cwd()` (per V1_SPEC §10).
- **GraphStore per call vs cached:** simplest is to `load()` per tool call. That's slow on large graphs but consistent. Cache + invalidate-on-write is task-019 (telemetry / perf) territory; don't over-optimize here.
- **Active-topic state:** module-scoped `let activeTopic: string | null = null;` with getter/setter. Reset on a new `set_active_topic` call. Per-turn cap reset (which currently lives nowhere) lands in task-014.
- **Error handling:** every tool returns `{ ok: false, error: { code, message } }` instead of throwing — the SDK surfaces these cleanly (TECH_SPEC §9).

## Steps

1. Update `TECH_SPEC.md` §5 to use the current SDK's `registerTool` pattern.
2. Create `src/tools/_active_topic.ts` with the module-scoped state.
3. Create one file per tool with the handler logic. Each handler takes `(args, ctx)` and returns the tool result. Don't wire them into a server yet.
4. Create `src/index.ts` exporting `registerTools(server, { repoRoot })` that calls `server.registerTool(...)` four times.
5. Create `bin/codemap-mcp.ts`. Stdio entry per TECH_SPEC §6.
6. Unit tests per tool (call handler directly). Use a tmp dir + customPath + the fixtures.
7. One integration test: spawn the server via `bun run bin/codemap-mcp.ts`, send `tools/list`, assert all 4 tools listed; then send a `tools/call` for each, assert the response.
8. Verify `bun build --compile bin/codemap-mcp.ts --outfile dist/codemap-mcp` produces a working binary.

## Exit criteria

- All 4 tools registered and callable.
- Unit + integration tests pass.
- `bun build --compile` produces a working binary.
- TECH_SPEC §5 patched.
- CI green.

## Notes

- **Don't add `emit_node` here.** It's task-014, depends on collision detection.
- **Don't add per-turn cap here.** Same — task-014.
- **MCP server config for testing locally:**
  ```json
  {
    "mcpServers": {
      "codemap": {
        "command": "bun",
        "args": ["run", "/abs/path/to/bin/codemap-mcp.ts"]
      }
    }
  }
  ```
  Drop into Claude Code's `~/.config/claude-code/mcp.json` (or equivalent path) to drive the server interactively while developing.

