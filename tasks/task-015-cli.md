# Task 015: CLI commands (`codemap show / correct / deprecate / validate / rollup`)

**Status:** done
**Phase:** M2 — Sprint 2.3 (CLI + polish)
**Estimate:** 3–4 hours
**Depends on:** task-007 (GraphStore), task-008 (validator)
**Blocks:** task-017 (distribution) — README references the CLI

## Goal

Add the human-facing CLI for inspecting and minimally correcting the graph. Lives at `bin/codemap.ts`; commands implemented per V1_SPEC §4 + TECH_SPEC §10.

```
codemap show <id>                          print one node + its edges
codemap correct <id> [--summary <s>] [--name <n>] [--confidence <0..1>] [--status <active|deprecated>] [--add-alias <a>] [--remove-alias <a>] [--add-tag <t>] [--remove-tag <t>]
codemap deprecate <id> [--reason <r>]
codemap validate                           dry-run validator; exit 0 if clean, 1 if issues, 2 if schema-invalid
codemap rollup                             stub in this PR; real rollup logic in task-016
```

## Decision required

### D1 — `correct` command flag style

**Choice (recommended): per-field typed flags.** `--summary "..."`, `--confidence 0.9`, `--status deprecated`, `--add-alias "..."`, `--remove-alias "..."`, `--add-tag "..."`, `--remove-tag "..."`. Sources / line_ranges are NOT correctable via CLI in v1 — they're complex shapes; needs an `$EDITOR` workflow that I'd defer to a later task.

Alternatives:
- `--field <name> --value <new>` (free-form): simpler signature but loses type safety. A `--value 1.5` for `confidence` would silently store a string-coerced number; weird.
- `codemap edit <id>` opening `$EDITOR` with YAML representation: most powerful but adds scope (YAML serializer, schema-aware re-validation on save, terminal-detection). Defer to v2.

I lean **typed flags** for v1. List flags (`--add-alias`/`--remove-alias`, `--add-tag`/`--remove-tag`) are explicit list mutations. All flags that target list fields can be passed multiple times via `commander`'s `.collect` pattern.

**Action:** confirm typed flags or overrule before implementation.

## Context

References:
- `V1_SPEC.md` §4 (in-scope CLI bullet) + §10 (CLI commands list).
- `TECH_SPEC.md` §8 (CLI design + sharing the GraphStore class).
- Installed deps: `commander` (already in package.json) — Command class, options with type coercion, multi-pass via `.action`.

## Deliverables

- `bin/codemap.ts` — entry script. Top-level `program.command(...)` for each of the 5 commands.
- `src/cli/show.ts` / `correct.ts` / `deprecate.ts` / `validate.ts` / `rollup.ts` — one file per command, each exporting a function that takes parsed args + an `options` object (so they're testable directly).
- `test/unit/cli.test.ts` — unit tests calling each command function directly with synthetic inputs.
- `test/integration/cli.test.ts` — spawns `bun run bin/codemap.ts <subcommand> ...` and asserts stdout / exit codes against a tmp-dir fixture graph.

## Per-command spec

### `show <id>`

- Loads GraphStore. Calls `getNode(id)` (alias-aware).
- Prints the full node JSON to stdout + the edges where the node is from-or-to.
- Exit 0 if found, exit 1 if not found.

### `correct <id> [...flags]`

- Loads GraphStore.
- Resolves `id` via `getNode` (alias-aware).
- Applies flags directly to the node fields:
  - `--summary <s>` → set `summary`
  - `--name <n>` → set `name`
  - `--confidence <num>` → set `confidence` (parsed as float; rejected if NaN or out of [0,1])
  - `--status <active|deprecated>` → set `status`
  - `--add-alias <a>` (repeatable) → append to `aliases` (deduped)
  - `--remove-alias <a>` (repeatable) → remove from `aliases`
  - `--add-tag <t>` (repeatable) → append to `tags` (deduped)
  - `--remove-tag <t>` (repeatable) → remove from `tags`
  - (Sources / line_range / content_hash / kind / id / last_verified_at are NOT correctable in v1.)
- Bumps `last_verified_at` to now (the manual edit IS a verification).
- Calls `save()`.
- Prints the updated node + a summary of fields changed. Exit 0 on success.

### `deprecate <id> [--reason <r>]`

- Sugar for `correct <id> --status deprecated` plus optional reason prepended to the node summary as `[deprecated: <reason>] <existing>`. Pattern matches the `force_new` summary-prefix convention from task-014 (D2).
- Exit 0 on success.

### `validate`

- Loads GraphStore (which already runs `validate()` + `applyRepairs()` per task-008).
- BUT: instead of applying repairs, run `validate()` standalone and PRINT issues. Don't save.
- Exit codes:
  - 0 if no issues at all
  - 1 if warnings or repairs would have happened (but no schema error)
  - 2 if schema is invalid (load() threw)

### `rollup`

- **Stub in this PR.** Print `"rollup: not yet implemented (task-016)"` and exit 0.
- Full implementation in task-016 (telemetry).

## Implementation notes

- **`commander` patterns:** `program.command("show <id>").action(async (id) => { ... })`. For repeatable flags use `.option("--add-tag <t>", "...", (val, prev) => [...prev, val], [])`.
- **GraphStore reuse:** the CLI uses the same `GraphStore.load(repoRoot)` call as the MCP server. `repoRoot` defaults to `process.cwd()`; expose `--repo <path>` as a global option for testing.
- **Output format:** plain JSON for machine-readable consumption. Add `--pretty` for human reading later (out of scope v1).
- **Error handling:** structured `{ ok: false, error: { code, message } }` on stderr; exit non-zero.
- **No interactive prompts** in v1 — every command is non-interactive. `correct` with no flags is a no-op (print warning, exit 0).

## Test plan

- `show` happy + miss + alias-resolved.
- `correct` each flag in isolation + multi-flag + invalid confidence.
- `correct` for repeatable flags (multiple `--add-tag`).
- `deprecate` sets status + prepends reason.
- `validate` on clean / dirty / malformed fixtures → correct exit codes + stderr.
- `rollup` prints stub message.
- Integration: spawn `bun run bin/codemap.ts <cmd>` and assert stdout / stderr / exit code on each.

## Exit criteria

- [ ] `bin/codemap.ts` registers all 5 commands with commander.
- [ ] Each command's logic is in `src/cli/<name>.ts` and unit-tested.
- [ ] Integration tests pass against the fixture corpus.
- [ ] `--help` prints something useful for each command.
- [ ] `bun build --compile bin/codemap.ts --outfile dist/codemap` produces a working binary alongside the existing `dist/codemap-mcp`.
- [ ] CI green.

## Notes

- The CLI deliberately doesn't attempt to be a full graph editor. Its purpose is "fix the agent's mistakes without opening graph.json by hand." Anything more ergonomic (TUI, $EDITOR integration) is v2.
- `rollup` lives here for command discoverability but its implementation lands in task-016.
- After this + 016 + 017, **Sprint 2.3 closes and v0.1.0 ships**.
- Historical status corrected during task-031 docs truth pass; the CLI shipped and is covered by `test/unit/cli.test.ts`.
