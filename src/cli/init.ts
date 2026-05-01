import { promises as fs } from "node:fs";
import * as path from "node:path";

import { agentsMdContent } from "../instructions.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

// =============================================================
// `codemap init` — generate project-level agent-guidance files
// (AGENTS.md and optionally CLAUDE.md) from the same lifecycle policy
// the MCP server attaches via `instructions`.
//
// Why this exists: M3a finding F1 — Codex Desktop drops the MCP
// `server.instructions` field, so the lifecycle policy never reaches
// the agent. AGENTS.md is the standard project-level preamble file
// for Codex/Codex CLI; we write the same body there so any agent
// reads it regardless of MCP-host behavior.
//
// Default behavior:
//   - Writes <repoRoot>/AGENTS.md.
//   - If the file exists, skips with a warning + exit 1 (so CI
//     scripts can detect). Pass --force to overwrite.
//   - --claude adds CLAUDE.md too. --all adds every known preamble
//     filename.
//
// Single source of truth for the body: src/instructions.ts ->
// agentsMdContent(). Updating SERVER_INSTRUCTIONS automatically
// updates what `codemap init` writes.
// =============================================================

export interface InitFlags {
  force?: boolean;
  /** Add CLAUDE.md alongside AGENTS.md. */
  claude?: boolean;
  /** Add all known preamble filenames (currently AGENTS.md + CLAUDE.md). */
  all?: boolean;
}

/** Filenames `init` may write, depending on flags. */
const ALL_TARGETS = ["AGENTS.md", "CLAUDE.md"] as const;

function pickTargets(flags: InitFlags): string[] {
  if (flags.all) return [...ALL_TARGETS];
  if (flags.claude) return ["AGENTS.md", "CLAUDE.md"];
  return ["AGENTS.md"];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function init(
  flags: InitFlags,
  globals: GlobalOptions,
): Promise<CommandResult> {
  const targets = pickTargets(flags);
  const projectName = path.basename(path.resolve(globals.repoRoot));
  const body = agentsMdContent(projectName);

  const wrote: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const filename of targets) {
    const targetPath = path.join(globals.repoRoot, filename);
    const present = await exists(targetPath);
    if (present && !flags.force) {
      skipped.push(filename);
      continue;
    }
    try {
      await fs.writeFile(targetPath, body, "utf8");
      wrote.push(filename);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${filename}: ${msg}`);
    }
  }

  // ---------- Build output ----------
  const lines: string[] = [];
  for (const f of wrote) {
    lines.push(`wrote ${f}`);
  }

  let stderr = "";
  for (const f of skipped) {
    stderr += `skipped ${f}: file exists (re-run with --force to overwrite)\n`;
  }
  for (const e of errors) {
    stderr += `error: ${e}\n`;
  }

  // Exit code rules:
  //   - any error → 2 (hard failure)
  //   - any skip without overwrite → 1 (so CI detects "init was a no-op")
  //   - otherwise → 0
  let exitCode = 0;
  if (errors.length > 0) exitCode = 2;
  else if (skipped.length > 0 && wrote.length === 0) exitCode = 1;

  return {
    exitCode,
    stdout: lines.length > 0 ? `${lines.join("\n")}\n` : undefined,
    stderr: stderr.length > 0 ? stderr : undefined,
  };
}
