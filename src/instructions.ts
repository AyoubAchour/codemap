// =============================================================
// MCP server.instructions string — attached to every agent's
// system prompt at `initialize` time. Per the MCP protocol, the
// server's `instructions` field reaches the client at the same
// hop as `serverInfo` and is the standard place to put cross-tool
// lifecycle policy that individual tool descriptions can't carry.
//
// History: M3a prompt 1 against voice2work (Codex Desktop) showed
// the agent calling `set_active_topic` and `query_graph` correctly
// but never `emit_node` / `link` after exploring 26 files. Codex
// reasoned: "Codemap doesn't have auth nodes indexed for this
// project, so I'm falling back to a direct repo read." That's the
// "treat-as-cache" failure mode — query miss → explore → done,
// no writeback. This module is the architectural fix:
// inject a lifecycle policy that explicitly demands writeback.
//
// The wording compresses the M1 spike's 3-checkpoint instruction
// doc (m1/instruction-doc.md) to ~180 words — small enough to fit
// the system-prompt budget of every session, prescriptive enough
// to leave no room for the "cache" interpretation.
// =============================================================

export const SERVER_INSTRUCTIONS = `This server is a persistent knowledge graph of the open codebase
(.codemap/graph.json). Treat it as memory — query before exploring,
WRITE AFTER.

LIFECYCLE for any task that touches this codebase:

1. START: set_active_topic("<short-slug>") — resets per-turn emit budget.
2. BEFORE PLANNING: query_graph("<task description>"). If it returns
   nodes, read via get_node before re-deriving from source.
3. AFTER EXPLORING: emit_node for what you learned. Cap = 5/turn.
   PRIORITIZE: decision (non-obvious choices), invariant (must-hold
   properties), gotcha (silent failure modes). File / symbol / flow
   only if non-obvious.
4. CAPTURE RELATIONSHIPS: link(from, to, kind). Kinds: imports, calls,
   depends_on (catch-all), implements, replaces, contradicts,
   derived_from, mirrors.

NEVER skip step 3 because the graph "looks empty after step 2" — that's
how it stays empty. The graph is only worth something if every agent
that explores leaves something behind.

Emit at confidence >= 0.5 only. emit_node detects collisions and returns
candidates; re-call with merge_with: <id> or force_new: { reason: "..." }.`;
