import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import { resolveMcpRepoRoot } from "../../src/mcp_repo_root.js";

describe("MCP repo root resolution", () => {
  test("--repo wins over environment and cwd", () => {
    const root = resolveMcpRepoRoot({
      argv: ["node", "codemap-mcp", "--repo", "explicit-repo"],
      env: {
        CODEMAP_REPO_ROOT: "env-repo",
        CLAUDE_PROJECT_DIR: "claude-repo",
      },
      cwd: "cwd-repo",
    });

    expect(root).toBe(path.resolve("explicit-repo"));
  });

  test("CODEMAP_REPO_ROOT wins when --repo is absent", () => {
    const root = resolveMcpRepoRoot({
      argv: ["node", "codemap-mcp"],
      env: {
        CODEMAP_REPO_ROOT: "env-repo",
        CLAUDE_PROJECT_DIR: "claude-repo",
      },
      cwd: "cwd-repo",
    });

    expect(root).toBe(path.resolve("env-repo"));
  });

  test("CLAUDE_PROJECT_DIR wins over cwd when no explicit root is set", () => {
    const root = resolveMcpRepoRoot({
      argv: ["node", "codemap-mcp"],
      env: {
        CLAUDE_PROJECT_DIR: "claude-repo",
      },
      cwd: "cwd-repo",
    });

    expect(root).toBe(path.resolve("claude-repo"));
  });

  test("falls back to cwd", () => {
    const root = resolveMcpRepoRoot({
      argv: ["node", "codemap-mcp"],
      env: {},
      cwd: "cwd-repo",
    });

    expect(root).toBe(path.resolve("cwd-repo"));
  });

  test("rejects --repo without a value", () => {
    expect(() =>
      resolveMcpRepoRoot({
        argv: ["node", "codemap-mcp", "--repo"],
        env: {},
        cwd: "cwd-repo",
      }),
    ).toThrow("--repo requires a path");
  });
});
