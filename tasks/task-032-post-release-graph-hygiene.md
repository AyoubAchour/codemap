# Task 032: Post-release graph hygiene

**Status:** done
**Phase:** Phase 4 / behavior consistency
**Target version:** post-0.5.0
**Depends on:** task-031

## Goal

Turn the 0.5.0 release into a cleaner everyday workflow by syncing release
truth, improving `codemap doctor` readability, and dogfooding the installed
package outside this repo.

## Context

The 0.5.0 release shipped `graph_health`, `codemap doctor`, and dependency-aware
source context. Running the new doctor against this repo immediately surfaced
stale graph anchors from old visual-extension work and long-lived docs churn.
That is a good product signal: health problems are now visible, but the compact
CLI path and local graph hygiene need a post-release pass.

## Deliverables

- README and handoff updated from "0.5.0 target" to "0.5.0 shipped".
- `codemap doctor` defaults to compact human-readable output.
- `codemap doctor --json` preserves the full structured health report for
  scripts and MCP-adjacent tooling.
- CLI command output now exits by setting `process.exitCode` instead of forcing
  `process.exit()`, so large non-zero JSON reports flush reliably.
- Local codemap graph hygiene dogfood pass for stale visual-extension memory.
- Installed-package dogfood pass in another real checkout.

## Exit criteria

- [x] Release-truth docs reflect npm/GitHub 0.5.0.
- [x] CLI doctor compact output is covered by tests.
- [x] `codemap doctor --json` is covered by tests.
- [x] Local graph health improves for obsolete visual-extension anchors.
- [x] Installed `codemap-mcp@0.5.0` is exercised outside this repo.
- [x] Full local verification suite is run and documented.

## Notes

The `.codemap/` directory is ignored in this repo, so graph hygiene is local
dogfood evidence rather than a PR diff. Durable lessons should still be emitted
through the MCP graph with real repo source anchors.

Local graph hygiene dogfood reduced active missing source anchors from 32 to 0
by deprecating 10 obsolete visual-extension nodes. Remaining active staleness is
changed live docs/code, not missing removed files.

Installed-package dogfood used global `codemap-mcp@0.5.0` in
`/home/kekawia/Desktop/Projects/voice2work`: `codemap scan` indexed 1,323 files,
7,690 chunks, and 6,395 symbols; `codemap context "auth guard source context"`
returned graph memory plus source hits; `codemap doctor --issue-limit 3`
reported the existing voice2work graph fresh.

Verification: `bun run typecheck`, `bun test`, `bun run build`,
`git diff --check`, `npm pack --dry-run`, `npx --yes publint`, and
`npx --yes @arethetypeswrong/cli --pack --ignore-rules cjs-resolves-to-esm`
passed. `npm publish --dry-run --provenance --access public` ran prepublish
build and tarball creation, then npm rejected overwriting the already-published
`0.5.0` version, which is expected for this post-release branch.
