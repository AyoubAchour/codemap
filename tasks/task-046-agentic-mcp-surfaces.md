# Task 046 — Agentic MCP surfaces

Status: done

Phase: Phase 4 / agent behavior

## Intent

Make agents use Codemap correctly through richer MCP surfaces, not just chat
reminders.

## Context

Competitors win onboarding by installing guidance, hooks, and skills
aggressively. Codemap should keep graph writes deliberate, but expose resources,
prompts, and setup checks that make the right lifecycle the default path for
MCP-aware clients.

## Deliverables

- Add MCP resources for graph health, source-index status, task lifecycle, and
  generated repo guidance where supported.
- Add prompt templates for planning, diff review, and writeback.
- Extend `codemap setup` checks so configured clients can verify reachable
  tools and guidance freshness.

## Exit Criteria

- [x] MCP resources/prompts are discoverable by compatible clients.
- [x] Setup health reports client config, server command, Node runtime, and
      guidance freshness.
- [x] The generated guidance remains repo-scoped and does not auto-write graph
      memory.

## Verification

- `bun test test/integration/mcp.test.ts --timeout 20000`
- `bun test test/unit/cli.test.ts --timeout 30000`
