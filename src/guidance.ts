import { promises as fs } from "node:fs";
import * as path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import {
  agentsMdContent,
  GUIDANCE_POLICY_HASH,
} from "./instructions.js";

export type GuidanceStatus = "current" | "missing" | "stale" | "error";

export interface GuidanceCheck {
  file: string;
  status: GuidanceStatus;
  reason?: string;
  version?: string;
  policyHash?: string;
  message?: string;
}

const GUIDANCE_METADATA_RE =
  /<!--\s*codemap:init\s+version=(\S+)\s+policy_hash=(sha256:[a-f0-9]+)\s*-->/;

export function guidanceBodyForRepo(repoRoot: string): string {
  const projectName = path.basename(path.resolve(repoRoot));
  return agentsMdContent(projectName, {
    codemapVersion: packageJson.version,
  });
}

export async function checkGuidanceFiles(
  repoRoot: string,
  targets: string[],
): Promise<GuidanceCheck[]> {
  const body = guidanceBodyForRepo(repoRoot);
  return Promise.all(
    targets.map((filename) =>
      checkGuidanceFile(filename, path.join(repoRoot, filename), body),
    ),
  );
}

export function formatGuidanceCheck(check: GuidanceCheck): string {
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

function parseGuidanceMetadata(content: string):
  | { version: string; policyHash: string }
  | null {
  const match = content.match(GUIDANCE_METADATA_RE);
  if (!match?.[1] || !match[2]) return null;
  return { version: match[1], policyHash: match[2] };
}

function normalizeGuidanceLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
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

  const comparableContent = normalizeGuidanceLineEndings(content);
  const metadata = parseGuidanceMetadata(comparableContent);
  if (comparableContent === expectedBody) {
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
