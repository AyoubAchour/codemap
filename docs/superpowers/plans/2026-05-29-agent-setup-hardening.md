# Agent Setup Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codemap setup reliable when agents install the MCP server globally but need repo-scoped tools and instructions.

**Architecture:** Keep global setup as the default, but add explicit repo-root resolution and project-scoped setup where clients support it. Treat repo-local guidance as the behavior layer and MCP config as the access layer.

**Tech Stack:** TypeScript, Bun tests, Commander CLI, MCP stdio server, JSON/TOML client config writers.

---

### Task 1: MCP Repo Root Resolution

**Files:**
- Create: `src/mcp_repo_root.ts`
- Modify: `bin/codemap-mcp.ts`
- Test: `test/unit/mcp_repo_root.test.ts`

- [x] **Step 1: Write failing resolver tests**

Add tests proving repo-root precedence:

```ts
expect(resolveMcpRepoRoot({ argv: ["node", "codemap-mcp", "--repo", "repo"], env: {}, cwd: "cwd" })).toBe(path.resolve("repo"));
```

- [x] **Step 2: Run the test and confirm RED**

Run: `bun test test/unit/mcp_repo_root.test.ts`

Expected: fails because `src/mcp_repo_root.ts` does not exist.

- [x] **Step 3: Implement resolver**

Resolve root in this order: `--repo`, `CODEMAP_REPO_ROOT`, `CLAUDE_PROJECT_DIR`, cwd.

- [x] **Step 4: Wire MCP entry**

Use `resolveMcpRepoRoot()` in `bin/codemap-mcp.ts`.

- [x] **Step 5: Verify GREEN**

Run: `bun test test/unit/mcp_repo_root.test.ts`

Expected: all resolver tests pass.

### Task 2: Setup Scope And Guidance Health

**Files:**
- Modify: `src/setup.ts`
- Modify: `src/cli/setup.ts`
- Modify: `bin/codemap.ts`
- Test: `test/unit/cli.test.ts`

- [x] **Step 1: Write failing setup tests**

Add tests for:

```ts
setupCodemap({ clients: ["claude"], check: true, repoRoot }).health.guidance.files
```

and:

```ts
setupCodemap({ clients: ["cursor"], scope: "project", repoRoot })
```

- [x] **Step 2: Run targeted RED test**

Run: `bun test test/unit/cli.test.ts -t setup`

Expected: fails because setup only checks `AGENTS.md`, writes Cursor global config, and has no project-scope Claude command.

- [x] **Step 3: Implement scope**

Add `SetupScope = "global" | "project"`, pass it from CLI flags into setup, and keep `global` as the default.

- [x] **Step 4: Implement project-scoped Cursor**

Write `.cursor/mcp.json` inside the repo with:

```json
{
  "mcpServers": {
    "codemap": {
      "command": "codemap-mcp",
      "args": ["--repo", "${workspaceFolder}"]
    }
  }
}
```

- [x] **Step 5: Implement Claude guidance check**

When Claude is selected, check both `AGENTS.md` and `CLAUDE.md`.

- [x] **Step 6: Verify GREEN**

Run: `bun test test/unit/cli.test.ts -t setup`

Expected: all setup tests pass.

### Task 3: Documentation And Task Index

**Files:**
- Modify: `README.md`
- Modify: `tasks/README.md`
- Create: `tasks/task-075-agent-setup-hardening.md`

- [x] **Step 1: Document install behavior**

Explain that MCP setup grants access while `codemap init` teaches behavior.

- [x] **Step 2: Document repo-root resolution**

Document the root order: `--repo`, `CODEMAP_REPO_ROOT`, `CLAUDE_PROJECT_DIR`, cwd.

- [x] **Step 3: Add task entry**

Add task 075 to `tasks/README.md`.

### Task 4: Verification

**Files:**
- No source changes.

- [x] **Step 1: Run focused tests**

Run:

```sh
bun test test/unit/mcp_repo_root.test.ts
bun test test/unit/cli.test.ts -t setup
```

- [x] **Step 2: Run full verification**

Run:

```sh
bun test test/unit/cli.test.ts
bun test test/integration/mcp.test.ts --timeout 20000
bun run typecheck
bun test
bun run build
git diff --check
```
