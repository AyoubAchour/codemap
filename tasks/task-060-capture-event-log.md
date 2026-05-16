# Task 060: Capture Event Log

**Status:** todo
**Phase:** Phase 4 / capture
**Estimate:** 3-5 days
**Depends on:** task-057
**Blocks:** task-061, task-062, task-063, task-064

## Goal

Store rebuildable session evidence that can later improve recall and writeback
suggestions without writing graph memory automatically.

## Context

Agentmemory wins on automatic capture. Codemap should capture the evidence of
work, but keep graph memory curated and source-anchored.

## Deliverables

- Capture event schema and validator.
- Local storage under `.codemap/index/capture/`.
- CLI commands for appending and inspecting capture events.
- Tests proving capture events do not modify `.codemap/graph.json`.

## Steps

1. Define event kinds for session lifecycle, prompts, files inspected, files
   modified, Codemap calls, recall hits, suggestions, and graph writes.
2. Add append/read helpers with safe JSONL handling.
3. Add CLI commands for manual capture and debugging.
4. Add excludes/redaction hooks before capturing prompt or tool-output text.
5. Test append, read, invalid event rejection, and graph isolation.

## Exit Criteria

- [ ] Capture storage is separate from curated graph storage.
- [ ] Capture events can be deleted without corrupting graph memory.
- [ ] Invalid or out-of-repo source anchors are rejected or warned on.
- [ ] Tests prove no capture path writes `.codemap/graph.json`.

## Notes

Capture evidence is useful only if future agents can audit it. Prefer boring
JSONL and clear schemas over clever compression.
