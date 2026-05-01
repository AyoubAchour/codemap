# Task 017: Distribution — README + npm publish + smoke test

**Status:** in-progress
**Phase:** M2 — Sprint 2.3 (closes Sprint 2.3 and the M2 milestone)
**Estimate:** 2–3 hours
**Depends on:** task-014 (5 tools done), task-015 (CLI), task-016 (telemetry)
**Blocks:** Phase 3 (M3 trial — needs an installable codemap)

## Goal

Make Codemap installable. After this task: `npx -y <package-name>` (or whatever local equivalent the user picks) drops the MCP server into a Claude Code config and runs end-to-end on a real codebase.

## Decisions required

### D1 — npm package name

Three reasonable picks:

- **`codemap-mcp`** (current `package.json` name, unscoped). Most discoverable. Risk: name collision — verify with `npm view codemap-mcp` before publishing.
- **`@ayoubachour/codemap-mcp`** (user-scoped). Always available, less discoverable, requires npm login.
- **Different name entirely** (e.g. `kg-mcp`, `code-knowledge-graph`). Avoid name collision and re-use.

**Recommendation: check `codemap-mcp` availability first; fall back to `@ayoubachour/codemap-mcp` if taken.** Run `npm view codemap-mcp 2>&1 | head -5` as the first step of this task — `404 Not Found` means available.

### D2 — Build target: TS-source via Bun runtime, OR pre-compiled JS via npm

**Two coherent options:**

- **A — Ship TS sources, require Bun at install time.** Smaller package, faster iteration. `bin` points at `.ts`; `npx -y` users must have Bun. Excludes Node-only users.
- **B — Ship pre-compiled JS via tsup (or `bun build` to JS, not the 100MB binary).** Standard npm pattern. Works under Node 22+ via `npx`. Heavier publish step but matches user expectations.

**Recommendation: B.** A real npm package should work for any Node 22+ user without forcing a Bun install. Add `tsup` as a dev dep or use `bun build --target=node bin/codemap-mcp.ts --outfile=dist/cli/codemap-mcp.js` (bun-as-bundler emitting Node-compatible JS, not a binary). Then update `bin` paths to point at the compiled JS.

### D3 — README scope

**Recommendation: lean install + 1-page tool overview.** Do NOT duplicate V1_SPEC / TECH_SPEC content. Link to them. Sections:

1. What this is (1 paragraph)
2. Install (`npx`, manual binary download)
3. Configure your MCP client (Claude Code config snippet)
4. The 5 tools (one line each)
5. Telemetry + opt-out
6. Links to specs + status

## Context

References:
- `TECH_SPEC.md` §13 — distribution policy.
- 2026 npm publishing best practices ([2ality ESM TypeScript guide](https://2ality.com/2025/02/typescript-esm-packages.html), [jsmanifest 2026 npm package guide](https://jsmanifest.com/create-modern-npm-package-2026)): ESM-only is fine; Node 23+ can `require()` ESM.
- Verification tools: `npm pack --dry-run`, `npx publint`, `npx attw --pack` (are-the-types-wrong).
- Claude Code MCP config docs.

## Deliverables

- **`README.md`** — install + configure + tool overview (per D3).
- **`package.json` updates:**
  - Verify / update `name` per D1.
  - `files` field whitelist (only ship `dist/`, `README.md`, `LICENSE`, no source).
  - `exports` field (ESM entry).
  - Bump `version` to `0.1.0`.
- **Build pipeline:**
  - `bun build --target=node` (or `tsup`) for `bin/codemap-mcp.ts` and `bin/codemap.ts` → `dist/cli/*.js`.
  - Update `bin` paths to `./dist/cli/codemap-mcp.js` and `./dist/cli/codemap.js`.
  - `prepublishOnly` script wires the build into npm publish.
- **`.npmignore`** — exclude `test/`, `fixtures/`, `m1/`, `notes/`, `tasks/`, `dist/codemap-mcp` (the 100MB compiled binary), specs, etc.
- **`scripts/smoke-test.sh`** (or similar) — install via `npm pack` + `npm install -g <tarball>`, run `codemap --help`, run `codemap-mcp` and verify it accepts an MCP `tools/list` JSON-RPC over stdin.
- **CI workflow update:** add a `publish-dryrun` job that runs `npm pack --dry-run`, `npx publint`, `npx --yes @arethetypeswrong/cli --pack` on every PR.

## Steps

1. `npm view codemap-mcp` — check availability. If taken, switch to `@ayoubachour/codemap-mcp` and document why.
2. Add `tsup` (or use `bun build --target=node`) as a build dependency.
3. Write the build script that emits Node-compatible JS to `dist/cli/`.
4. Update `package.json`: `bin`, `files`, `exports`, `version`, `prepublishOnly`.
5. Write `.npmignore`.
6. Write `README.md` per D3.
7. Write `scripts/smoke-test.sh` and run it locally.
8. Update CI to run `npm pack --dry-run` + `publint` + `attw` on every PR.
9. Verify the package bundle is sane: `npm pack && tar -tvf codemap-mcp-0.1.0.tgz | head -30`.
10. **Do NOT actually publish in this PR.** Publishing is a one-time manual user action per the free-personal-project context (TECH_SPEC §13 cost note). Provide the exact command for the user to run.

## Exit criteria

- [ ] D1, D2, D3 confirmed by user.
- [ ] `npm view <name>` shows the name is available (or scope decision made).
- [ ] Build pipeline emits Node-compatible JS to `dist/cli/`.
- [ ] `bin` paths point at compiled JS, not TS.
- [ ] `npm pack --dry-run` shows only the intended files (no test/, no fixtures, no specs).
- [ ] `publint` and `attw` checks pass (or known limitations documented).
- [ ] `scripts/smoke-test.sh` succeeds locally.
- [ ] README written per D3.
- [ ] CI green; new `publish-dryrun` job in CI.

## Notes

- **The actual `npm publish` is a user action.** This task ships everything ready-to-publish and provides the exact command. The user runs `npm publish` (or `npm publish --provenance` for attestation, recommended) when they're ready.
- After this task lands + the user publishes:
  - The Claude Code MCP config snippet in the README points at the published package.
  - **M3 (per ROADMAP Phase 3) becomes the next milestone.** Task-011 (3c target) becomes immediately actionable.
- Sprint 2.3 closes when this merges. **M2 milestone completes.**

## What's intentionally NOT here

- Hosted version (cloud SaaS). v2.
- Cross-compiled binary for non-Linux platforms. Rely on `npx` for cross-platform; users on Apple Silicon / Windows can build their own with `bun build --compile`.
- Auto-update. v2.
- Plugin discovery. v2.
