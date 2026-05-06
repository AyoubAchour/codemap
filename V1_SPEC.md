# Codemap — V1 Specification

> Working name. Rename freely.

## 1. One-line summary

A persistent, queryable knowledge graph of a codebase, built incrementally by AI agents during normal work, exposed via MCP, stored as a JSON file in the repo. Optimized to capture the **non-obvious knowledge** (decisions, invariants, gotchas) that agents otherwise rediscover or hallucinate every session.

## 2. Core thesis

The product is a **memory layer for codebases**, not a visualization tool or general conversation memory. Human-facing views can sit on top later; the graph itself is the value.

The graph's *highest-value content* is **not** file summaries — Cursor and Claude Code already do that. It is the knowledge that doesn't live in any single file:

- **Decisions** — "we use Supabase auth, not Clerk; chose because of RLS."
- **Invariants** — "user.role can never be null after registration."
- **Gotchas** — "Stripe webhooks fail silently if amount=0."
- **Integration quirks** — service-specific behaviors that bit us once.

File summaries are discoverable. Decisions / invariants / gotchas compound across sessions and across teammates — that's where the moat is.

## 3. Problems being solved


| Pain                                                          | How the graph solves it                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Agent hallucinates / re-invents components that already exist | Agent queries the graph before planning; sees existing auth, db client, integrations, and prior decisions. |
| Knowledge from one session evaporates by the next             | Graph is committed to the repo; persists across sessions, machines, team members.                          |
| Hard to verify what an agent did across many edits            | (Deferred to v2) Graph diff overlay shows touched nodes per turn.                                          |


V1 explicitly addresses pains 1 and 2. Pain 3 is v2.

## 4. Scope

### In scope (V1)

- An **MCP server** exposing the curated graph-memory tools to any MCP-capable agent.
- A rebuildable **local source index** for cold-start source discovery, kept separate from the curated graph.
- A **graph schema** stored as a single JSON file at `<repo_root>/.codemap/graph.json`.
- An **agent instruction document** organized around **explicit enforcement checkpoints** (not ad-hoc directives).
- **Server-side enforcement** of collision detection, schema validation, and per-turn emission caps.
- A **basic CLI** (`codemap show / correct / deprecate / validate / doctor`) so humans can inspect and fix graph issues without a UI, plus source-index commands (`scan / search-source / index-status / clear-index`) for local code discovery.
- Tested end-to-end against **Claude Code** as the reference agent.

### Out of scope (V1)

- Web UI / editor extension / canvas viewer. Visual surfaces wait until behavior is consistent.
- Live file-watcher / real-time graph updates (v2). Graph mutates only when the agent emits.
- Branch-safe operation. V1 is single-branch, single-writer; see §15 Limitations.
- Behavioral graph extraction — auto-detected state machines, enum invariants, data-flow tracing (v2+).
- Multi-agent compatibility validation; v1 ships agent-agnostic via MCP, but only Claude Code is verified.
- Vector / embedding-based search; the graph uses tag + text match, and source discovery starts with local lexical/symbol ranking.

## 5. Architecture

```
┌──────────────────────────────────────┐
│  AI Agent (Claude Code is reference) │
└─────────────────┬────────────────────┘
                  │ MCP protocol
                  ▼
┌──────────────────────────────────────┐
│  Codemap MCP Server                  │
│  Tools:                              │
│    - query_context / graph_health    │
│    - index_codebase / search_source  │
│    - get_index_status / clear_index  │
│    - query_graph                     │
│    - get_node                        │
│    - emit_node  (collision-aware)    │
│    - link                            │
│    - set_active_topic                │
│  Server enforces:                    │
│    - collision detection             │
│    - per-turn emission cap           │
│    - schema validation on load       │
└─────────────────┬────────────────────┘
                  │ atomic reads/writes
                  ▼
┌──────────────────────────────────────┐
│  <repo_root>/.codemap/graph.json     │
│  - JSON, keyed maps (not arrays)     │
│  - Committed to git                  │
│  - Single source of truth            │
└──────────────────────────────────────┘
```

## 6. Data model

### 6.1 Node

```json
{
  "id": "auth/middleware",
  "kind": "file | symbol | package | integration | concept | flow | decision | invariant | gotcha",
  "name": "Auth Middleware",
  "summary": "1-2 sentence description.",
  "sources": [
    {
      "file_path": "src/auth/middleware.ts",
      "line_range": [1, 80],
      "content_hash": "sha256:..."
    }
  ],
  "tags": ["auth", "shared"],
  "aliases": ["auth-mw"],
  "status": "active",
  "confidence": 0.9,
  "last_verified_at": "ISO-8601 timestamp"
}
```

**Field notes:**

- `**id`** — stable slug. Used for merge-on-duplicate. Format: `domain/name` (e.g. `auth/middleware`, `payment/stripe-webhook`).
- `**kind**` — three families:
  - **Syntactic / structural:** `file`, `symbol`, `package` — what the code is.
  - **Conceptual:** `integration`, `concept`, `flow` — what role the code plays.
  - **Knowledge (highest value):** `decision`, `invariant`, `gotcha` — non-obvious truths a teammate would tell you. **Prefer these whenever applicable.** They are harder to rediscover than file summaries.
- `**tags`** — drive UI views in v2. Always include the active topic at emission. Multi-tagged nodes (e.g. `User` model tagged both `auth` and `payment`) are expected.
- `**aliases**` — alternative IDs that resolve to this node. Server consults during `query_graph` and `get_node`. Reduces ID-drift damage when the agent re-invents a name.
- `**status**` — `"active"` (default) or `"deprecated"`. Orthogonal to `confidence`: a node can be deprecated and high-confidence (we know it's gone) or active and low-confidence (we're unsure).
- `**confidence**` — verification certainty, NOT relevance. `0.9+` = directly inspected; `0.5-0.8` = inferred; `<0.5` = do not emit.
- `**sources[].content_hash**` — SHA-256 of source file contents at last verification. Staleness is detected by hash mismatch. mtime is **not** used — it changes on git checkout / clone / rebase / copy without content changes.
- `**last_verified_at`** — kept for human readability; the actual staleness check uses `content_hash`.

### 6.2 Edge

```json
{
  "from": "auth/middleware",
  "to": "auth/jwt",
  "kind": "imports | calls | depends_on | implements | replaces | contradicts | derived_from | mirrors",
  "note": "optional 1-line context"
}
```

**Edge `kind` enum** (8 values, strict):

| Kind | Use when |
|---|---|
| `imports` | A code-level `import` / `require` from one node's source to another's. |
| `calls` | A function or method invocation across two nodes. |
| `depends_on` | A conceptual or behavioral dependency that isn't a literal import or call. Catch-all when no specific kind fits. |
| `implements` | One node implements an interface, contract, or pattern defined by another. |
| `replaces` | Supersedes another (typically pairs with `status: "deprecated"` on the replaced node). |
| `contradicts` | Two nodes describe mutually exclusive truths. Surfaces conflicts. |
| `derived_from` | One node exists or is shaped because of another — Y is the *originating reason* for X. Stronger than `depends_on`: captures provenance. |
| `mirrors` | Two nodes follow the same pattern or convention without one depending on the other. Sibling, not parent-child. |

`derived_from` and `mirrors` were added after the M1 trial showed agents naturally reach for these semantic distinctions; without them, post-tightening edges collapsed into a `depends_on` monoculture (7/9 edges).

**Edge identity:** uniquely keyed by the triple `(from, to, kind)`. Calling `link()` again with the same triple **updates** `note`. Stored as keyed map (see §6.3) to keep diffs sane.

### 6.3 Graph file

```json
{
  "version": 1,
  "created_at": "ISO timestamp",
  "topics": {
    "payment": { "created_at": "...", "auto_created": true }
  },
  "nodes": {
    "auth/middleware": { "kind": "...", "name": "...", ... }
  },
  "edges": {
    "auth/middleware|auth/jwt|imports": { "note": "..." }
  }
}
```

**Why keyed maps, not arrays:** git merges resolve cleanly per-key. With arrays, two devs adding nodes on different branches generate ordering churn that conflicts on every line. Keyed maps eliminate this for the typical case. Branch-safety is still imperfect (see §15) but conflict surface shrinks dramatically.

## 7. MCP tools

### 7.0 `query_context(question: string) → { graph, source, related_nodes, warnings, next_steps }`

Preferred pre-planning read path for codebase tasks. It composes `query_graph`,
source staleness checks, source-index status, source search, and related graph
nodes into one response. It never writes graph memory and never auto-generates
nodes from the source index; source hits are still a rebuildable discovery cache
that must be inspected in real files before `emit_node`. Source search results
may include bounded dependency context (`imports` / `imported_by`) and bounded
symbol/file impact context to help the agent inspect nearby files before
forming a durable finding. Impact context distinguishes exact indexed
definitions/import relationships from approximate lexical references; it is
planning context, not proof of every runtime effect.

### 7.1 `query_graph(question: string) → { nodes, edges }`

Called by the agent **before planning** any task involving code understanding. Returns top-N relevant nodes (by tag overlap + text match in `name` / `summary` / `tags` / `aliases`) plus connecting edges. Resolves through aliases.

### 7.2 `get_node(id: string) → Node`

Resolves through aliases. Returns full node detail.

### 7.3 `emit_node(id, kind, name, summary, sources, confidence, status?, aliases?) → { ok | collision }`

Flat parameters (LLMs handle these more reliably than nested objects).

**Server-side collision detection.** Before creating a *new* `id`, the server computes a similarity score against existing nodes (fuzzy name match, source-file overlap, tag overlap, alias match). If similarity exceeds a threshold:

```json
{
  "ok": false,
  "collision": true,
  "candidates": [
    { "id": "payment/checkout", "name": "Checkout flow", "similarity": 0.87 }
  ],
  "next_action": "re-call emit_node with merge_with: <id>  OR  force_new: true with reason: <string>"
}
```

The agent must then either:

- Re-call with `merge_with: "<existing_id>"` → server merges incoming data into that node.
- Re-call with `force_new: true, reason: "<short explanation>"` → server creates as new and stores the reason for audit.

This makes ID-drift recovery a **server guarantee**, not an agent-discipline one. The reviewer flagged this as a key gap; collision detection on the server closes it.

**Merge semantics** (when `merge_with` is set, or when emitting an existing `id`):

- Extend `tags` with current active topic.
- Merge `aliases`.
- Refresh `sources[].content_hash` and `last_verified_at`.
- Replace `summary` only if incoming `confidence` ≥ existing.

**Per-turn cap.** The server tracks emissions per agent turn (heuristic: per `set_active_topic` call). After 5 successful emissions, further calls return `{ ok: false, capped: true }`. Prevents "let me map the whole repo" runaway.

### 7.4 `link(from, to, kind, note?) → ack`

Idempotent. Same `(from, to, kind)` updates `note`.

### 7.5 `set_active_topic(name: string) → ack`

Agent calls at task start. All subsequent `emit_node` calls auto-tag with this topic. If `name` is new, added to `topics{}` with `auto_created: true`. Resets the per-turn emission counter.

### 7.6 `graph_health(include_deprecated?: boolean, issue_limit?: number) → { summary, issues, suggestions }`

Read-only health inspector for curated graph memory. It reports validator
warnings/repairs plus source-anchor staleness grouped by reason (`changed`,
`missing`, `unsafe_path`, `read_error`). By default it checks active nodes only;
deprecated nodes can be included explicitly. Response arrays are capped by
`issue_limit` while summary totals remain uncapped. It never repairs or writes
the graph.

### 7.7 Source-index tools

`index_codebase`, `search_source`, `get_index_status`, and `clear_index` manage
the rebuildable local source index at `.codemap/index/source.json`. They are for
source discovery only and must not be treated as curated graph conclusions.

## 8. Agent instruction document

This is the highest-leverage artifact in V1. The MCP server is mechanical; **the instruction doc is what makes the loop work**. Treat as a product surface.

The instructions are organized around **three explicit enforcement checkpoints**, not ad-hoc directives. Models follow checklists more reliably than open-ended guidance.

Draft (refine during M1 spike):

```
You have access to a Codemap MCP server. It maintains a persistent
knowledge graph of this codebase. Use it as a repo memory layer — not optional
for codebase work, but not general chat or web-research memory.

Use Codemap only when the task touches this repository's code, docs,
architecture, roadmap, tests, or build/release behavior. For unrelated Q&A,
general web research, installs, recommendations, or external documentation
questions, do not call Codemap tools and do not write graph nodes.

═══════════════════════════════════════════════════════════════
CHECKPOINT 1 — BEFORE YOU PLAN
═══════════════════════════════════════════════════════════════
For any task that involves understanding or modifying this codebase,
you MUST do this first:

1. Call set_active_topic(<short-slug>) — e.g. "payment", "auth-bugfix".
2. Call query_context(<task description>) when available; otherwise call
   query_graph(<task description>) to find existing context.
3. Treat source dependency/impact context as a navigation hint, not proof.
   Inspect the real files before relying on source-index results.
4. If graph memory looks stale or duplicated, call graph_health to see the
   grouped source-anchor and validator issues.
5. For each returned node: if any source's stored content_hash differs
   from current file contents, re-read the source and update via
   emit_node before relying on it.

Skipping this checkpoint will make you re-invent or hallucinate
existing components. It is a failure mode, not a shortcut.

═══════════════════════════════════════════════════════════════
CHECKPOINT 2 — AFTER YOU EXPLORE, BEFORE YOU FINALIZE
═══════════════════════════════════════════════════════════════
Emit nodes only for durable repo-local knowledge anchored to real project
files. The server will cap you at 5 emissions per turn — choose the
highest-value ones.

PRIORITIZE these kinds (this is the actual win):
- decision: "we use Supabase auth, not Clerk; chose for X reason"
- invariant: "user.role can never be null after registration"
- gotcha: "Stripe webhooks fail silently if amount=0"

THEN, only if relevant:
- integration: a meaningful external service / library boundary
- flow: a multi-step sequence (only if it crosses ≥3 files)
- concept: a developer-mental-model concept

AVOID emitting:
- file summaries unless the file's role is non-obvious
- one node per function — emit at the level a developer would
  describe to a teammate
- trivial helpers, getters, one-liners
- speculative content with confidence < 0.5
- facts learned only from conversation, web pages, package docs, install
  steps, or external research

When in doubt, do NOT emit. Quality over coverage.

═══════════════════════════════════════════════════════════════
CHECKPOINT 3 — BEFORE FINAL RESPONSE
═══════════════════════════════════════════════════════════════
- For each meaningful relationship discovered, call link(from, to, kind).
- If you noticed something gone (renamed/removed), call emit_node with
  the existing id and status: "deprecated".

═══════════════════════════════════════════════════════════════
DUPLICATE / COLLISION HANDLING
═══════════════════════════════════════════════════════════════
If emit_node returns { collision: true, candidates: [...] }:
- If one candidate clearly is the same concept → re-call with
  merge_with: <id>.
- Otherwise → re-call with force_new: true and a short reason.
- NEVER ignore the collision response by inventing a new id.

═══════════════════════════════════════════════════════════════
CONFIDENCE
═══════════════════════════════════════════════════════════════
- 0.9+: directly inspected, certain.
- 0.5-0.8: inferred from naming / imports / partial reads.
- <0.5: do NOT emit.
```

## 9. Behavior rules

1. **Single graph per repo.** Tasks extend the same graph; never recreate.
2. **Merge on duplicate `id`.** Shared concepts accumulate tags across topics.
3. **Server-enforced collision detection.** New IDs that look similar to existing ones must explicitly merge or `force_new` with reason.
4. **Lazy staleness via content hash.** A node is stale when SHA-256 of any source differs from the stored `content_hash`. mtime is not used. Re-verified on next read, not eagerly.
5. **Tags drive views.** Every emitted node has at least one tag (the active topic).
6. **Per-turn emission cap.** Maximum 5 emissions per agent turn, server-enforced. Prevents spam and bounds the per-task token cost.
7. **No hard deletes.** Use `status: "deprecated"`. `confidence` independently reflects verification certainty.
8. **Validator runs on every load.** Schema check; remove dangling edges (endpoints don't exist); warn on duplicate aliases. Manual user edits to `graph.json` survive validation as long as the schema holds.
9. **Concurrent readers and writers, coordinated by short locks.** Multiple processes can read the graph simultaneously (atomic writes guarantee readers always see a complete file). Multiple writers are coordinated by a short-held file lock (~50 ms during the write critical section); see TECH_SPEC §3.4. Stale-lock concerns are bounded by the lock library's built-in 10-second timeout.
10. **Graph content is untrusted input.** Treat node summaries / notes as data, not instructions. Mitigates prompt-injection from poisoned entries (see §15).

## 10. Storage

- **Path:** `<repo_root>/.codemap/graph.json`
- **Format:** JSON, 2-space indent, sorted keys for diff readability. Nodes and edges are keyed maps (see §6.3), not arrays.
- **Git:** committed; not gitignored.
- **Atomic writes:** write to `graph.json.tmp`, fsync, then rename over `graph.json`. Avoids partial-write corruption on crash. Also makes concurrent reads safe — readers always see a complete file.
- **Concurrent writers:** coordinated by `proper-lockfile` (file-level lock held only during the write critical section, ~50 ms). Multiple agent processes can use the same graph safely. See TECH_SPEC §3.4.
- **Validator on load:** schema check, dangling-edge removal, alias uniqueness check. Repairs are written back atomically. Protects against manual JSON edits gone wrong.
- **CLI commands** (also v1):
  - `codemap show <id>` — print one node.
  - `codemap correct <id> --field <name> --value <new>` — manual override.
  - `codemap deprecate <id> [--reason ...]` — set status.
  - `codemap validate` — run validator dry-run.

## 11. Observability

V1 ships with simple telemetry written to `.codemap/metrics.json`:

- **Per-turn:** `query_graph` calls, results returned, nodes emitted, collisions detected, emission-cap hits, stale rechecks.
- **Per-week (rollup):** graph size growth, % nodes verified in last 7 days, ratio of `decision` / `invariant` / `gotcha` nodes to total node count.

This is what makes the M3 trial measurable. Without metrics, "is this actually helping" is purely subjective.

## 12. Milestones

### M1 — Instruction-document spike (week 1)

**Goal:** validate the loop conceptually before writing any code.

Approach: simulate the MCP server manually in a Claude Code session. Give Claude the instruction document + a fake `graph.json` that Claude can read/edit. Run **4–6 sequential tasks all within one subsystem** (e.g. the auth subsystem of a project you know well). Do not span the whole repo on the first trial — payback timeline depends on task clustering.

**Success criteria (all required):**

1. By task 4–6, Claude meaningfully re-uses nodes from earlier tasks instead of re-exploring.
2. Claude maintains the discipline at all 3 checkpoints **without explicit reminders**.
3. At least 30% of emitted nodes are `decision` / `invariant` / `gotcha` kinds — not just file summaries.
4. Claude does NOT skip the writeback loop. If by task 2 it's omitting Checkpoint 2, the instruction document needs redesign before any MCP-server code is written.

This is the make-or-break test. The reviewer's biggest-risk call is "agents will skip writeback because cost is immediate, benefit delayed" — M1 is the direct probe of that.

### M2 — MVP MCP server (weeks 2–3)

Implement the 5 MCP tools, server-side collision detection, validator, basic CLI. JSON storage with keyed maps.

**Success criterion:** end-to-end loop works; graph persists; collisions are resolved without ID drift.

### M3 — Real-codebase trial (weeks 3–5)

1–2 weeks of real use on a working codebase.

**Success criteria** (mix of telemetry + subjective):

- Graph size grows steadily without spam (emission-cap hits should be rare; sustained cap-hits = instructions need tuning).
- Stale-recheck rate < 10% of queries.
- `decision`/`invariant`/`gotcha` ratio sustained ≥ 25% of total nodes.
- Subjectively: I trust the agent more on follow-up tasks; less re-explanation needed.

## 13. Open questions

To decide as we build, not now:

1. **Granularity beyond the cap.** Is 5/turn the right number? May need lowering if quality drops, or raising if useful work is being suppressed. Tune during M1.
2. **Semantic search.** V1 = tag + text + alias match. May add embeddings if M3 reveals retrieval is the bottleneck.
3. **Tab creation in V2 UI.** Auto-create on `set_active_topic` vs. user-created explicitly.
4. **Schema migration.** When v2 adds fields, how do we upgrade existing graphs? Probably a `migrate()` function gated on `version`.
5. **Monorepo.** One graph at repo root vs. per-package. V1 = single graph at root.
6. **Approval friction.** Claude Code may prompt user to approve each MCP tool call. Investigate per-tool auto-approve in `~/.claude/settings.json` before M2; if not solvable, batched-emit may be needed.
7. **Branch / PR semantics.** Two devs on different branches both modify `graph.json`. Keyed maps reduce churn but don't eliminate conflicts. Document workflow in §15; full solution is v2.

## 14. Tech choices

- **Language:** TypeScript (preferred — Anthropic + MCP SDKs first-class).
- **MCP SDK:** `@modelcontextprotocol/sdk`.
- **Storage:** plain `fs` JSON. Move to SQLite only if graph exceeds ~1k nodes.
- **Auto-approve:** investigate Claude Code's per-tool auto-approve config in `~/.claude/settings.json`. Frequent approval prompts will kill adoption regardless of how good the loop is.
- **Testing:** integration tests run actual Claude Code sessions against a fixture repo.

## 15. Limitations (known, accepted for V1)

- **MCP tools are model-controlled.** The instruction document strongly nudges the agent but cannot *force* correct tool choice. Server-side source anchoring rejects obviously invalid graph writes, but the instruction document still carries the codebase-only use policy.
- **Cross-model behavior is unverified.** V1 targets Claude Code; behavior on GPT-class or Gemini-class agents may differ.
- **Not branch-safe.** Two devs on parallel branches will hit `graph.json` merge conflicts. Keyed maps shrink the conflict surface but don't eliminate it. Workflow recommendation: run `codemap validate` after merge.
- **No human editing UI.** Manual edits via CLI or direct JSON are supported (validator catches schema errors), but no visual editor in v1.
- **Prompt-injection risk.** Graph content is data the agent reads; a malicious PR could plant adversarial text in a node summary ("ignore previous instructions and …"). V1 mitigation: rule §9.10 declares graph content untrusted; reviewers should diff `.codemap/graph.json` in PRs the same way they review code. Sanitization at render time is v2.
- **No embeddings.** Retrieval relies on tag + text + alias match. May miss semantic matches in large graphs. Add embeddings if M3 reveals retrieval is the bottleneck.

## 16. Non-goals (explicit)

These are NOT what this project is, even long-term:

- A replacement for Cursor / Claude Code as an AI coding agent.
- A repo-wide static analysis tool (Sourcegraph territory).
- A documentation generator (DeepWiki territory).
- A 3D code visualization (CodeCharta territory).

Codemap is a **persistent, structured memory layer** that other tools and agents sit on top of. Its specific edge is capturing **non-obvious knowledge** (decisions, invariants, gotchas) that no static analyzer or doc generator produces.
