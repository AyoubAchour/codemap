import { promises as fs } from "node:fs";
import * as path from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import {
  agentsMdContent,
  GUIDANCE_POLICY_HASH,
} from "../instructions.js";
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
//   - --check performs a read-only freshness check over the selected
//     filenames and exits 0 only when every selected guidance file is current.
//
// Single source of truth for the body: src/instructions.ts ->
// agentsMdContent(). Updating SERVER_INSTRUCTIONS automatically
// updates what `codemap init` writes.
// =============================================================

export interface InitFlags {
  force?: boolean;
  /** Check whether selected generated guidance is current without writing. */
  check?: boolean;
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

type GuidanceStatus = "current" | "missing" | "stale" | "error";

interface GuidanceCheck {
  file: string;
  status: GuidanceStatus;
  reason?: string;
  version?: string;
  policyHash?: string;
  message?: string;
}

const GUIDANCE_METADATA_RE =
  /<!--\s*codemap:init\s+version=(\S+)\s+policy_hash=(sha256:[a-f0-9]+)\s*-->/;

function parseGuidanceMetadata(content: string):
  | { version: string; policyHash: string }
  | null {
  const match = content.match(GUIDANCE_METADATA_RE);
  if (!match?.[1] || !match[2]) return null;
  return { version: match[1], policyHash: match[2] };
}

async function checkGuidanceFile(
  file: string,
  targetPath: string,
  expectedBody: string,
): Promise<GuidanceCheck> {
  let content: string;
  try {
    content = await fs.readFile(targetPath, "utf8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        file,
        status: "missing",
        reason: "file_missing",
      };
    }
    return {
      file,
      status: "error",
      reason: "read_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const metadata = parseGuidanceMetadata(content);
  if (content === expectedBody) {
    return {
      file,
      status: "current",
      version: metadata?.version,
      policyHash: metadata?.policyHash,
    };
  }

  if (!metadata) {
    return { file, status: "stale", reason: "missing_metadata" };
  }
  if (metadata.version !== packageJson.version) {
    return {
      file,
      status: "stale",
      reason: "version_mismatch",
      version: metadata.version,
      policyHash: metadata.policyHash,
    };
  }
  if (metadata.policyHash !== GUIDANCE_POLICY_HASH) {
    return {
      file,
      status: "stale",
      reason: "policy_hash_mismatch",
      version: metadata.version,
      policyHash: metadata.policyHash,
    };
  }
  return {
    file,
    status: "stale",
    reason: "content_mismatch",
    version: metadata.version,
    policyHash: metadata.policyHash,
  };
}

function formatGuidanceCheck(check: GuidanceCheck): string {
  if (check.status === "current") {
    return `${check.file}: current (version ${check.version ?? "unknown"}, policy ${check.policyHash ?? "unknown"})`;
  }
  if (check.status === "missing") {
    return `${check.file}: missing (run codemap init${check.file === "CLAUDE.md" ? " --claude" : ""})`;
  }
  if (check.status === "error") {
    return `${check.file}: error (${check.message ?? check.reason ?? "read_error"})`;
  }
  const details = [
    check.reason ?? "stale",
    check.version ? `version ${check.version}` : undefined,
    check.policyHash ? `policy ${check.policyHash}` : undefined,
  ].filter(Boolean);
  return `${check.file}: stale (${details.join(", ")})`;
}

async function checkGuidance(
  targets: string[],
  body: string,
  globals: GlobalOptions,
): Promise<CommandResult> {
  const checks = await Promise.all(
    targets.map((filename) =>
      checkGuidanceFile(filename, path.join(globals.repoRoot, filename), body),
    ),
  );
  const hasError = checks.some((check) => check.status === "error");
  const allCurrent = checks.every((check) => check.status === "current");

  return {
    exitCode: hasError ? 2 : allCurrent ? 0 : 1,
    stdout: `${checks.map(formatGuidanceCheck).join("\n")}\n`,
  };
}

export async function init(
  flags: InitFlags,
  globals: GlobalOptions,
): Promise<CommandResult> {
  if (flags.check && flags.force) {
    return {
      exitCode: 1,
      stderr:
        "error: --check is read-only and cannot be combined with --force\n",
    };
  }

  const targets = pickTargets(flags);
  const projectName = path.basename(path.resolve(globals.repoRoot));
  const body = agentsMdContent(projectName, {
    codemapVersion: packageJson.version,
  });

  if (flags.check) {
    return checkGuidance(targets, body, globals);
  }

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
