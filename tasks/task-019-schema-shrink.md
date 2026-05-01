# Task 019: schema-shrink hotfix — emit_node visibility in OpenAI-class clients (v0.1.2)

**Status:** in-progress (fixes approved, implementing)
**Phase:** M3 / Sprint 3a
**Estimate:** 30 minutes
**Depends on:** task-018 (v0.1.1 published)
**Blocks:** continued M3a trial run (prompts 2-6 pointless until emit_node is callable from Codex)

## The finding

After v0.1.1, M3a prompt 1 v3 against voice2work via Codex Desktop with `AGENTS.md` preamble showed:

- **H_A confirmed**: Codex Desktop drops MCP `server.instructions`; user-side AGENTS.md was honored.
- Codex tried to follow the lifecycle and went looking for `emit_node` — its verbatim words: *"the MCP surface in this session exposes read/query/link but not an emit_node call... this session's Codemap MCP surface does not expose emit_node, so I could not safely write these findings back."*

`emit_node` is missing from Codex's tool view. Manually drove the v0.1.1 MCP server with `tools/list` — server returns all 5 tools including `emit_node`. **Codex Desktop is filtering it out client-side.**

Schema sizes:

| Tool | Bytes | Surfaced? |
| --- | --- | --- |
| `query_graph` | 349 | ✅ |
| `get_node` | 228 | ✅ |
| `link` | 674 | ✅ |
| `set_active_topic` | 233 | ✅ |
| **`emit_node`** | **2052** | **❌** |

`emit_node`'s schema is uniquely large, and the bulk is one regex pattern.

## Root cause

Two MCP-tool input-schema features that OpenAI's function-call subset of JSON Schema rejects:

1. **`last_verified_at: z.iso.datetime()`** — Zod 4 generates a ~350-char leap-year regex pattern. OpenAI's sandboxed regex validator rejects patterns of this complexity. **Primary cause.**
2. **`sources[].line_range: z.tuple([...])`** — emits the older tuple-array JSON Schema syntax (`items: [schemaA, schemaB]`). OpenAI's spec wants `items` to be a single schema (uniform array). **Probable contributor.**

## Fix

| File | Change |
| --- | --- |
| `src/schema.ts` | `SourceRefSchema.line_range`: tuple → `z.array(z.number().int().min(1)).length(2)`. Keep the `.refine(start <= end)` for ordering. Storage `NodeSchema.last_verified_at` stays `z.iso.datetime()` — load-time validation remains strict. |
| `src/tools/emit_node.ts` | inputSchema's `last_verified_at`: `z.iso.datetime()` → `z.string()` with descriptive label. Add runtime `Date.parse` check at handler entry; return `INVALID_TIMESTAMP` error if unparseable. |
| `bin/codemap-mcp.ts`, `bin/codemap.ts`, `package.json` | Bump version to `0.1.2`. |
| `test/integration/mcp.test.ts` | New assertion: `emit_node` is in `tools/list` output AND its `last_verified_at` schema has no `pattern` field. Pins the regression. |
| `tasks/README.md` | Mark task-018 done, add task-019 in-progress. |

## Trade-off (intentional)

Tool input schema becomes intentionally weaker than storage schema. The MCP boundary validates with runtime checks; the on-disk graph still validates strictly at load. Net result: OpenAI-class clients can call the tool; bad input is still rejected — just at the handler instead of the schema.

## Exit criteria

- [ ] Manual `tools/list` of v0.1.2: `emit_node` schema is under 1KB and contains zero `pattern` fields
- [ ] All tests pass (was 235; +1 for the schema-shape assertion = 236)
- [ ] CI green (`test-bun`, `test-node`, `publish-dryrun`)
- [ ] After republish: M3a prompt 1 v4 emits ≥3 nodes
- [ ] If 0 nodes after v0.1.2: open task-020 — the issue is policy (Codex blocks "destructive" tools), not protocol

## Notes

- This is the last protocol-impedance fix expected. If v0.1.2 still doesn't surface `emit_node` to the agent, the cause is Codex Desktop's tool-policy layer, not schema compatibility.
