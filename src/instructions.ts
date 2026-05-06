import { createHash } from "node:crypto";

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
//
// In v0.2.0 (task-021), the same body is also rendered into
// project-level AGENTS.md / CLAUDE.md files via `codemap init`,
// because Codex Desktop drops `server.instructions` (M3a finding F1).
// Single source of truth — agentsMdContent() reads SERVER_INSTRUCTIONS
// so the in-protocol and in-file copies cannot drift.
// =============================================================

export const SERVER_INSTRUCTIONS = `This server is a persistent knowledge graph of the open codebase
(.codemap/graph.json), not general chat or web-research memory. Treat it as
repo memory — query before exploring, WRITE AFTER.

USE CODEMAP ONLY when the task touches this repository's code, docs,
architecture, roadmap, tests, or build/release behavior. Do not call
query_context, changes_context, query_graph, get_node, graph_health,
suggest_writeback, emit_node, link, index_codebase, search_source,
get_index_status, or clear_index for unrelated Q&A, general web research, installs,
recommendations, or tasks not anchored to this repo.

Source discovery tools are a rebuildable cache, not memory:
query_context/changes_context/index_codebase/search_source/get_index_status/
clear_index may help find code faster, but they must not be treated as durable
conclusions and must not auto-generate graph nodes. Dependency and impact
context are navigation hints, not durable relationships unless confirmed from
real files.

LIFECYCLE for any task that touches this codebase:

1. START: set_active_topic("<short-slug>") — resets per-turn emit budget.
2. BEFORE PLANNING: query_context("<task description>") when available.
   Otherwise call query_graph("<task description>"). If graph nodes are
   returned, read via get_node before re-deriving from source.
3. SOURCE DISCOVERY (optional): query_context includes source-index status and
   source hits, including nearby imports/importers and bounded impact context
   when available. If using
   query_graph directly, use search_source for source chunks after query_graph;
   if the index is missing/stale, use index_codebase or get_index_status. If
   graph memory looks stale or duplicated, use graph_health. Inspect real files
   before relying on search results.
4. DIFF CHECK (when changes exist): call changes_context before committing,
   reviewing, or summarizing changes. Treat likely tests/docs and impact
   context as prompts to inspect, not proof.
5. BEFORE ENDING: call suggest_writeback with inspected/modified files or a
   short work summary when useful. Treat suggestions as prompts, not memory.
6. AFTER EXPLORING: emit_node only for durable repo-local knowledge
   anchored to real project files. Cap = 5/turn.
   PRIORITIZE: decision (non-obvious choices), invariant (must-hold
   properties), gotcha (silent failure modes). File / symbol / flow
   only if non-obvious.
7. CAPTURE RELATIONSHIPS: link(from, to, kind). Kinds: imports, calls,
   depends_on (catch-all), implements, replaces, contradicts,
   derived_from, mirrors.

NEVER skip the writeback check because the graph "looks empty after step 2" —
that's how it stays empty. The graph is only worth something if every agent
that explores this repo leaves something behind. But if the task did not touch
this repo, leave the graph alone.

Emit at confidence >= 0.5 only. emit_node detects collisions and returns
candidates; re-call with merge_with: <id> or force_new: { reason: "..." }.
emit_node rejects sources that are empty, absolute, outside the repo, missing
from disk, or external URLs.`;

export const GUIDANCE_POLICY_HASH = `sha256:${createHash("sha256")
  .update(SERVER_INSTRUCTIONS)
  .digest("hex")}`;

export interface AgentsMdContentOptions {
  codemapVersion?: string;
}

/**
 * Render the project-level AGENTS.md / CLAUDE.md preamble. Wraps
 * SERVER_INSTRUCTIONS with a header (so users know where the file came from)
 * and a footer (so they know how to regenerate after upgrading codemap-mcp).
 *
 * Used by the `codemap init` CLI to seed agent-guidance files in projects
 * whose MCP client doesn't surface server.instructions (Codex Desktop as of
 * 2026-04 — see task-020 / M3a finding F1).
 */
export function guidanceMetadata(version: string): string {
  return `<!-- codemap:init version=${version} policy_hash=${GUIDANCE_POLICY_HASH} -->`;
}

export function agentsMdContent(
  projectName?: string,
  options: AgentsMdContentOptions = {},
): string {
  const heading = projectName
    ? `# ${projectName} — agent guidance (codemap)`
    : "# Agent guidance (codemap)";
  const version = options.codemapVersion ?? "unknown";
  return `${heading}

${guidanceMetadata(version)}

This file was generated by \`codemap init\`. It tells MCP-aware agents
(Codex, Claude Code, etc.) how to use the **Codemap** MCP server attached to
this project.

Some MCP clients (e.g. Codex Desktop as of 2026-04) drop the server's
\`instructions\` field, so the lifecycle policy below is mirrored here to
guarantee the agent sees it.

---

## Agent Contract

Use Codemap for repository work only. For unrelated Q&A, general web research,
installs, recommendations, or external documentation lookup, do not call Codemap
tools and do not write graph nodes.

For repo work, follow the lifecycle exactly:

1. Start with \`set_active_topic("<short-slug>")\`.
2. Prefer \`query_context("<task>")\` before planning.
3. Treat source-index results as discovery hints only; inspect real files before
   relying on them.
4. Use \`changes_context\` before committing, reviewing, or summarizing a diff.
5. If graph memory is stale, duplicated, or suspicious, call \`graph_health\`
   before trusting it.
6. Before ending, call \`suggest_writeback\` when useful; it is read-only and
   never creates graph memory.
7. After exploring, write back only durable repo-local decisions, invariants,
   gotchas, or confirmed relationships with real source anchors.

---

${SERVER_INSTRUCTIONS}

---

## Why this file exists

Without it, an agent that finds the codemap MCP server will treat it as a
read-only cache: query → miss → fall back to direct exploration → done.
That leaves the graph empty forever and the next agent re-discovers the
same things from scratch. The point of codemap is the writeback loop in
step 4 above for real repository exploration. This file tells the agent both
when to write and when to leave the graph alone.

## Regenerating

After \`npm i -g codemap-mcp@latest\`, regenerate this file to pick up any
lifecycle-policy updates:

\`\`\`sh
codemap init --check
codemap init --force
\`\`\`
`;
}
