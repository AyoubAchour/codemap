import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { GraphStore } from "./graph.js";
import {
  getSourceIndexStatus,
  loadSourceIndex,
  type IndexedSourceFile,
  type SourceIndexStatus,
  type SourceSymbol,
} from "./source_index.js";

const DEFAULT_OUTPUT = ".codemap/skills/codemap-repo/SKILL.md";

export interface GenerateRepoSkillsOptions {
  outputPath?: string;
  check?: boolean;
  stdout?: boolean;
}

export interface GenerateRepoSkillsResponse {
  ok: true;
  target_path: string;
  wrote: boolean;
  current: boolean;
  source: SourceIndexStatus;
  summary: {
    graph_nodes: number;
    source_files: number;
    source_symbols: number;
    areas: string[];
  };
  warnings: string[];
  next_steps: string[];
}

interface RepoSkillRender {
  body: string;
  sourceStatus: SourceIndexStatus;
  graphNodeCount: number;
  areas: Array<{
    name: string;
    files: number;
    symbols: number;
  }>;
}

export async function generateRepoSkills(
  repoRoot: string,
  options: GenerateRepoSkillsOptions = {},
): Promise<GenerateRepoSkillsResponse & { content?: string }> {
  const targetPath = path.resolve(repoRoot, options.outputPath ?? DEFAULT_OUTPUT);
  const render = await repoSkillRender(repoRoot);
  const current = await fileMatches(targetPath, render.body);
  const warnings: string[] = [];

  if (!render.sourceStatus.indexed) {
    warnings.push("Source index is missing; generated repo skill has limited source-area detail.");
  } else if (!render.sourceStatus.fresh) {
    warnings.push("Source index is stale; generated repo skill may describe old source structure.");
  }

  let wrote = false;
  if (!options.check && !options.stdout && !current) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, render.body, "utf8");
    wrote = true;
  }

  const response = {
    ok: true as const,
    target_path: path.relative(repoRoot, targetPath),
    wrote,
    current,
    source: render.sourceStatus,
    summary: {
      graph_nodes: render.graphNodeCount,
      source_files: render.sourceStatus.files_indexed,
      source_symbols: render.sourceStatus.symbols_indexed,
      areas: render.areas.map((area) => area.name),
    },
    warnings,
    next_steps: repoSkillNextSteps({
      check: options.check ?? false,
      stdout: options.stdout ?? false,
      current,
      wrote,
      sourceStatus: render.sourceStatus,
    }),
  };

  return options.stdout ? { ...response, content: render.body } : response;
}

async function repoSkillRender(repoRoot: string): Promise<RepoSkillRender> {
  const projectName = path.basename(path.resolve(repoRoot));
  const sourceStatus = await getSourceIndexStatus(repoRoot);
  const index = await loadSourceIndex(repoRoot);
  const graph = await GraphStore.load(repoRoot);
  const files = Object.values(index?.files ?? {});
  const areas = summarizeAreas(files);
  const exported = summarizeExports(files);
  const memory = graph
    .listNodes()
    .filter((node) => ["decision", "gotcha", "invariant"].includes(node.kind))
    .slice(0, 12);
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        version: packageJson.version,
        source: sourceStatus.updated_at ?? null,
        files: sourceStatus.files_indexed,
        symbols: sourceStatus.symbols_indexed,
        memory: memory.map((node) => node.id),
      }),
    )
    .digest("hex");

  const body = `---
name: codemap-repo-context
description: Generated Codemap repo context for ${projectName}. Use for repository tasks only; regenerate with codemap generate-skills.
---

# Codemap Repo Context: ${projectName}

<!-- codemap:generated-skill version=${packageJson.version} hash=sha256:${contentHash} -->

This is generated guidance, not curated graph memory. It is safe to delete and
regenerate. Do not copy facts from this file into the graph unless you verify
them from real project files.

## Use This When

- You are working in this repository's code, tests, docs, build, release, or architecture.
- You need a fast orientation before calling Codemap tools.
- You are reviewing a diff and want a reminder to call changes_context.

## Required Codemap Loop

1. Start with set_active_topic.
2. Use query_context before planning.
3. Use changes_context before committing or reviewing a diff.
4. Inspect real files before trusting generated or indexed context.
5. Use suggest_writeback near the end; write graph nodes only for durable repo-local lessons.

## Source Index Snapshot

- indexed: ${sourceStatus.indexed}
- fresh: ${sourceStatus.fresh}
- updated_at: ${sourceStatus.updated_at ?? "not indexed"}
- files: ${sourceStatus.files_indexed}
- chunks: ${sourceStatus.chunks_indexed}
- symbols: ${sourceStatus.symbols_indexed}

## Main Source Areas

${areas.length > 0 ? areas.map((area) => `- ${area.name}: ${area.files} files, ${area.symbols} symbols`).join("\n") : "- No indexed source areas yet."}

## Exported Symbols To Recognize

${exported.length > 0 ? exported.map((entry) => `- ${entry.name} (${entry.kind}) in ${entry.file_path}`).join("\n") : "- No exported symbols found in the current source index."}

## Curated Memory Highlights

${memory.length > 0 ? memory.map((node) => `- ${node.id} (${node.kind}): ${node.name}`).join("\n") : "- No curated decision/invariant/gotcha memory found yet."}

## Boundaries

- This file is generated from the source index plus graph summaries.
- It must not be treated as proof.
- Prefer fresh graph nodes and inspected files over this file.
- For unrelated Q&A, web research, installs, or recommendations, do not use Codemap.
`;
  return {
    body,
    sourceStatus,
    graphNodeCount: graph.listNodes({ includeDeprecated: true }).length,
    areas,
  };
}

function summarizeAreas(files: IndexedSourceFile[]): Array<{
  name: string;
  files: number;
  symbols: number;
}> {
  const byArea = new Map<string, { files: number; symbols: number }>();
  for (const file of files) {
    const area = file.file_path.includes("/")
      ? file.file_path.split("/")[0] ?? file.file_path
      : ".";
    const current = byArea.get(area) ?? { files: 0, symbols: 0 };
    current.files += 1;
    current.symbols += file.symbols.length;
    byArea.set(area, current);
  }
  return [...byArea.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
    .slice(0, 10);
}

function summarizeExports(files: IndexedSourceFile[]): Array<
  SourceSymbol & { file_path: string }
> {
  return files
    .flatMap((file) =>
      file.symbols
        .filter((symbol) => symbol.exported)
        .map((symbol) => ({ ...symbol, file_path: file.file_path })),
    )
    .sort(
      (a, b) =>
        a.file_path.localeCompare(b.file_path) ||
        a.line - b.line ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 24);
}

async function fileMatches(filePath: string, expected: string): Promise<boolean> {
  try {
    return (await fs.readFile(filePath, "utf8")) === expected;
  } catch {
    return false;
  }
}

function repoSkillNextSteps(input: {
  check: boolean;
  stdout: boolean;
  current: boolean;
  wrote: boolean;
  sourceStatus: SourceIndexStatus;
}): string[] {
  const steps: string[] = [];
  if (!input.sourceStatus.indexed) {
    steps.push("Run codemap scan before generating richer repo guidance.");
  } else if (!input.sourceStatus.fresh) {
    steps.push("Refresh the source index before relying on generated repo guidance.");
  }
  if (input.check && !input.current) {
    steps.push("Regenerate with codemap generate-skills.");
  }
  if (input.wrote) {
    steps.push("Tell agents this file is generated orientation, not durable memory.");
  }
  if (input.stdout) {
    steps.push("Review the generated guidance before writing it to disk.");
  }
  if (steps.length === 0) {
    steps.push("Generated repo guidance is current.");
  }
  return steps;
}
