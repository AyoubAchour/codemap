# Task 064: Observability and Replay Report

**Status:** done
**Phase:** Phase 4 / observability
**Estimate:** 3-5 days
**Depends on:** task-060, task-062, task-063

## Goal

Make capture, recall, suggestions, and graph writes inspectable from local files.

## Context

Agentmemory has a real-time viewer and replay surface. Codemap should start with
a cheaper local report so users can audit behavior before any full UI or editor
extension is unparked.

## Deliverables

- `codemap capture-report` JSON output.
- Optional static HTML report after JSON output is stable.
- Session timeline view of capture events.
- Summary of recall hits, writeback suggestions, graph writes, ignored events,
  and budget usage.

## Steps

1. Add report builder over capture events, summaries, and graph write records.
2. Add CLI command with `--json`, `--session`, and optional `--html`.
3. Add tests for report ordering, missing session ids, and empty repos.
4. Document how to inspect a session after a Codex run.

## Exit Criteria

- [x] The report runs without a server or hosted dependency.
- [x] The JSON output is stable enough for tests and future UI work.
- [x] Graph writes are distinguishable from capture-only events.
- [x] The report makes token/byte budget use visible.

## Notes

Do not restart visual graph work here. This task is about auditability of the
memory loop, not graph visualization.

Delivered in this task:

- `codemap capture-report` builds a read-only JSON audit report from
  `.codemap/index/capture/events.jsonl`.
- Reports include per-session timelines, recall hits, writeback suggestions,
  graph-write events, stale anchors, ignored malformed capture lines, and
  captured budget fields.
- Malformed capture lines are surfaced under `ignored_events` instead of failing
  the whole report.
- Static HTML remains deferred until the JSON report shape has dogfood mileage.
