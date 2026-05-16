# Agentmemory Catch-Up Specification

Status: draft
Date: 2026-05-16

## Purpose

Codemap should catch up to the parts of Agentmemory that make an agent feel
immediately useful across sessions: automatic capture, fast recall, small
context packets, easy setup, replayable history, and public benchmark evidence.

This does not mean turning Codemap into a transcript database. Codemap's moat is
still curated, source-anchored repo memory: decisions, invariants, gotchas, and
relationships that a future agent can trust.

## Current Evidence

Agentmemory was checked live on 2026-05-16:

- GitHub release: `v0.9.16`, published 2026-05-15.
- npm latest: `@agentmemory/agentmemory@0.9.16`.
- Codemap npm latest: `codemap-mcp@0.8.0`.
- Agentmemory README claims 6 Codex hooks, 51 MCP tools when the server is
  reachable, 4 skills, a viewer/replay surface, and shared memory across many
  agents.
- Agentmemory LongMemEval-S retrieval report claims R@5 95.2%, R@10 98.6%, and
  MRR 88.2% for BM25+vector retrieval, with BM25-only at R@5 86.2%.
- Agentmemory scale report claims top-10 context stays near 1,900-2,000 tokens
  as observation count grows, with hybrid search around 17.49 ms at 10,000
  observations and 108.72 ms at 50,000 observations on its reported machine.

Local Codemap benchmark evidence from the same investigation:

- `benchmark-retrieval` over the current Codemap suite: 14 queries, average
  latency around 214.5 ms, average response around 92 KB, file hit rate 1.0,
  precision 0.2, recall 0.7798, MRR 0.8929.
- Compact/standard response-mode experiments with `--max-content-chars 120`
  reduced latency only slightly, to about 197-198 ms, because the response still
  carries broad planning context.

The comparison is not apples-to-apples: Agentmemory measures memory top-K recall
over observations, while Codemap measures fused repo planning context. The gap
is still useful: Codemap needs a deliberately smaller recall surface, not only a
large planning surface.

## Competitive Gaps

### 1. Automatic capture

Agentmemory wins because it records work from lifecycle hooks. Codemap currently
depends on agents remembering to call `suggest_writeback` and then explicitly
emitting graph nodes.

Catch-up target: capture rebuildable session evidence automatically, but keep
curated graph writes explicit.

### 2. Token-budgeted recall

Agentmemory wins because the default recall output is a small context packet.
Codemap's `query_context` is excellent for planning but too large to be the only
memory retrieval primitive.

Catch-up target: add a `recall_context` style surface that returns only the most
useful repo memory and source snippets under a strict token/byte budget.

### 3. Retrieval quality claims

Agentmemory wins on public benchmark framing: R@K, MRR, scale, token savings,
and reproducibility are front-and-center.

Catch-up target: extend Codemap benchmarks with recall-focused cases, payload
budgets, and latency gates that can be compared across lexical, graph, semantic,
and reranker variants.

### 4. Observability and replay

Agentmemory wins because users can inspect what was captured and replay a
session timeline.

Catch-up target: start with a local CLI/static report showing capture events,
recall hits, writeback suggestions, and explicit graph writes. Do not build a
full visual graph viewer yet.

### 5. Onboarding polish

Agentmemory wins because it packages setup around concrete agents: connect
commands, hooks, MCP config, doctor checks, and an obvious health story.

Catch-up target: add Codemap capture-hook setup/check flows that install or
print exact config for supported clients, with Codex first.

### 6. Optional local semantic path

Agentmemory's quality jump comes from BM25+local vector retrieval. Codemap has
semantic adapter seams, but no bundled local provider.

Catch-up target: add a benchmark-only local embedding provider experiment first.
Promote it to an opt-in runtime feature only if the benchmark improves recall or
payload quality enough to justify dependency and privacy costs.

## Product Principles

- Capture evidence automatically; write graph memory deliberately.
- Rebuildable event logs are not durable graph memory.
- Token budget is a first-class API constraint, not a formatting afterthought.
- Local-first remains the default; no hosted database or hosted embedding
  provider is required for normal use.
- Benchmarks must land before new retrieval complexity becomes default behavior.
- Visual work stays parked until behavior, recall, and writeback quality are
  good enough to trust.

## Proposed Architecture

### Capture event log

Add a rebuildable capture layer under `.codemap/index/`, for example:

- `.codemap/index/capture/events.jsonl`
- `.codemap/index/capture/sessions.json`

Events should describe observed work, not curated memory:

- session start/stop
- user prompt summary when available
- tool use metadata
- files inspected
- files modified
- Codemap MCP calls
- recall requests and selected hits
- writeback suggestions shown
- graph writes actually emitted

Events must be safe to delete and rebuild where possible. They must never be
treated as trusted graph memory.

Task 060 implements the first slice with JSONL event storage and CLI commands:

- `codemap capture-event <kind>` appends redacted evidence.
- `codemap capture-session [session]` summarizes captured evidence for a
  session.

Supported event kinds cover session lifecycle, prompts, files inspected, files
modified, Codemap calls, recall hits, writeback suggestions, and graph writes.
Capture paths write only under `.codemap/index/capture/` and do not modify
`.codemap/graph.json`.

### Recall context

Add a smaller surface than `query_context`:

- MCP: `recall_context`
- CLI: `codemap recall-context`

Inputs:

- natural-language question
- optional files/symbols
- token or byte budget
- desired result count
- mode: `graph`, `source`, or `mixed`

Outputs:

- compact answer packet
- top graph nodes with trust/freshness
- top source snippets with line anchors
- optional capture/session evidence
- omitted-result counts
- budget accounting
- warnings when recall is incomplete

### Capture hooks

Task 061 adds opt-in setup/check support for lifecycle hooks where the client
supports them, starting with Codex because the current user workflow is
Codex-heavy.

Codex hook onboarding lives in `codemap setup` behind `--capture-hooks` instead
of a separate setup command, so MCP config and hook config share one health
surface. `--check` is read-only and reports missing or stale hook config;
`--dry-run` reports planned writes. The Codex implementation writes a small
`~/.codex/codemap/capture-hook.mjs` helper and merges matching entries into
`~/.codex/hooks.json` without duplicating them on repeated runs.

Hook scripts call small Codemap capture commands, not graph write commands. The
Codex helper only invokes `codemap capture-event` for rebuildable evidence such
as session start/end, prompts, Codemap calls, and file modifications. It never
calls `emit_node`, `link`, or writes `.codemap/graph.json`.

### Writeback suggestions from captured evidence

Extend `suggest_writeback` so it can consume capture evidence for the current
session. Suggestions should become more accurate without becoming automatic.

### Observability and replay

Start with a local report:

- `codemap capture-report`
- optional `--html`
- optional `--session <id>`

The report should answer:

- what was captured?
- what was recalled?
- what was suggested?
- what was written to graph memory?
- what was ignored, and why?

### Optional local semantic provider

Build on the existing adapter-gated semantic retrieval work. The next step is a
local, benchmark-only provider experiment. Runtime enablement should remain
explicitly opt-in until benchmark and install costs are proven acceptable.

## Task Sequence

1. Task 057 - Agentmemory catch-up planning.
2. Task 058 - Recall benchmark parity and payload budgets.
3. Task 059 - Token-budgeted `recall_context`.
4. Task 060 - Capture event log and event schema.
5. Task 061 - Capture hook onboarding.
6. Task 062 - Capture-backed writeback suggestions.
7. Task 063 - Session summaries and recall profiles.
8. Task 064 - Observability and replay report.
9. Task 065 - Local semantic provider experiment.

## Gates

- `recall_context` respects its token/byte budget in tests.
- New capture paths never modify `.codemap/graph.json`.
- Writeback remains explicit through `emit_node` and `link`.
- Benchmark output includes recall@K, MRR, precision/recall, latency, response
  bytes, budget compliance, and diversity.
- Hook setup supports `--check` and is idempotent.
- Hook setup supports a read-only `--dry-run` preview before writes.
- Report/replay output is useful from local files alone.
- Optional semantic retrieval stays disabled by default until benchmark evidence
  justifies changing that posture.

## Risks

Graph pollution:
Keep capture logs rebuildable and graph writes explicit.

Privacy:
Default to local files. Provide clear excludes and redaction before capturing
tool outputs or prompts.

Hidden token spend:
Make budget accounting visible in every recall response.

Hook fragility:
Treat hooks as optional accelerators. MCP and CLI workflows must still work
without them.

Scope creep:
Ship the local report before any full viewer or editor extension.

## Source Links

- Agentmemory repo: https://github.com/rohitg00/agentmemory
- Agentmemory README: https://raw.githubusercontent.com/rohitg00/agentmemory/main/README.md
- Agentmemory LongMemEval report: https://raw.githubusercontent.com/rohitg00/agentmemory/main/benchmark/LONGMEMEVAL.md
- Agentmemory scale report: https://raw.githubusercontent.com/rohitg00/agentmemory/main/benchmark/SCALE.md
- Agentmemory releases: https://github.com/rohitg00/agentmemory/releases
