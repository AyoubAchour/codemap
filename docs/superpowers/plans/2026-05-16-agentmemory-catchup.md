# Agentmemory Catch-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the useful Agentmemory gap - automatic capture, compact recall,
replay, onboarding, and benchmark evidence - while preserving Codemap's curated
repo graph.

**Architecture:** Add a rebuildable capture layer and compact recall surface
beside the existing graph/source-index stack. Capture logs may feed
`suggest_writeback`, but only explicit `emit_node` and `link` calls can change
`.codemap/graph.json`.

**Tech Stack:** Bun, TypeScript, MCP SDK, existing Codemap CLI/tool structure,
existing source index, existing retrieval benchmark harness.

---

## Phase 1 - Benchmark Before Behavior

- [x] Implement task 058.
- [x] Extend `benchmarks/retrieval.codemap.json` or add a sibling recall suite
      that measures compact memory recall separately from full planning context.
- [x] Update `src/retrieval_benchmark.ts` and `bin/codemap.ts` so benchmark
      output includes recall@K, MRR, latency, response bytes, diversity, and
      budget compliance.
- [x] Add tests in `test/unit/retrieval_benchmark.test.ts` for budget and metric
      reporting.
- [x] Verify with:
      - `bun run typecheck`
      - `bun test test/unit/retrieval_benchmark.test.ts`
      - `bun run bin/codemap.ts benchmark-retrieval --refresh-index if_stale`

## Phase 2 - Compact Recall Surface

- [x] Implement task 059.
- [x] Add core recall logic in `src/recall_context.ts`.
- [x] Add MCP wrapper in `src/tools/recall_context.ts`.
- [x] Add CLI wrapper in `src/cli/recall_context.ts`.
- [x] Register the tool in `src/index.ts` and the command in `bin/codemap.ts`.
- [x] Add tests for token/byte budget compliance, trust/freshness warnings,
      source anchors, and empty-result behavior.
- [x] Verify with:
      - `bun run typecheck`
      - `bun test`
      - `bun run bin/codemap.ts recall-context "how does writeback stay explicit?" --budget 2000`

## Phase 3 - Rebuildable Capture Evidence

- [ ] Implement task 060.
- [ ] Add event types and validation in `src/capture_events.ts`.
- [ ] Store events under `.codemap/index/capture/` so they are separate from
      curated graph memory.
- [ ] Add CLI commands such as `codemap capture-event` and
      `codemap capture-session`.
- [ ] Add tests that prove capture events never write `.codemap/graph.json`.
- [ ] Verify with:
      - `bun run typecheck`
      - `bun test`
      - `git diff --check`

## Phase 4 - Hook Setup and Checks

- [ ] Implement task 061.
- [ ] Extend setup logic in `src/setup.ts` or add `src/capture_setup.ts` for
      client-specific capture hook setup.
- [ ] Start with Codex hook instructions/config because this repo is dogfooded
      in Codex.
- [ ] Support dry-run/check output before writes.
- [ ] Add docs to `README.md` and generated guidance only after the command is
      tested.
- [ ] Verify idempotence by running the check command twice.

## Phase 5 - Better Writeback Suggestions

- [ ] Implement task 062.
- [ ] Extend `src/writeback_suggestions.ts` to accept capture/session evidence.
- [ ] Keep suggestions read-only and grouped by decision, invariant, gotcha, and
      relationship.
- [ ] Add tests showing captured evidence improves source-anchor candidates
      without auto-emitting nodes.
- [ ] Verify with:
      - `bun test test/unit/writeback_suggestions.test.ts`
      - MCP `suggest_writeback` smoke test in this repo.

## Phase 6 - Session Summaries and Profiles

- [ ] Implement task 063.
- [ ] Add local session/profile summaries derived from capture events.
- [ ] Keep summaries rebuildable until a human/agent promotes a specific finding
      into graph memory.
- [ ] Add tests for stale source anchors, redaction, and summary refresh.

## Phase 7 - Observability and Replay

- [ ] Implement task 064.
- [ ] Add `codemap capture-report` with JSON output first.
- [ ] Add optional static HTML only after JSON output is stable.
- [ ] Include capture events, recall hits, writeback suggestions, graph writes,
      and budget accounting.
- [ ] Verify generated reports do not require a server or external service.

## Phase 8 - Local Semantic Provider Experiment

- [ ] Implement task 065.
- [ ] Add a local embedding provider behind the existing semantic retrieval
      adapter interface.
- [ ] Keep it benchmark-only at first.
- [ ] Compare lexical-only, graph-only, mixed, and local-vector variants on the
      same benchmark suite.
- [ ] Promote only if recall/payload gains beat install and maintenance cost.

## Done When

- [ ] Codemap has a compact recall surface with hard budget tests.
- [ ] Codemap can capture session evidence automatically without graph writes.
- [ ] `suggest_writeback` can use capture evidence while remaining read-only.
- [ ] A local report makes capture and recall auditable.
- [ ] Benchmarks make retrieval quality, latency, and payload tradeoffs visible.
- [ ] README/HANDOFF/ROADMAP describe the sequence without implying automatic
      graph writes.
