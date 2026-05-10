import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { GraphStore } from "./graph.js";
import {
  scoreGraphMemoryQuality,
  type GraphMemoryFreshness,
  type GraphMemoryTrust,
} from "./graph_quality.js";
import {
  getSourceIndexStatus,
  loadSourceIndex,
  type IndexedSourceFile,
  type SourceIndexStatus,
  type SourceSymbol,
} from "./source_index.js";
import { checkSourceStaleness } from "./staleness.js";
import type { Node } from "./types.js";

const DEFAULT_OUTPUT = ".codemap/skills/codemap-repo/SKILL.md";
const AREA_HASHES_RE = /<!--\s*codemap:area-hashes\s+(\{[^\n]*\})\s*-->/;
const AREA_LIMIT = 10;
const AREA_FILE_LIMIT = 8;
const AREA_EXPORT_LIMIT = 12;
const AREA_MEMORY_LIMIT = 6;
const GLOBAL_MEMORY_LIMIT = 12;
const DURABLE_MEMORY_KINDS = new Set<Node["kind"]>([
  "decision",
  "gotcha",
  "invariant",
]);

export interface GenerateRepoSkillsOptions {
  outputPath?: string;
  check?: boolean;
  stdout?: boolean;
}

export interface RepoGuidanceAreaSummary {
  name: string;
  file_path: string;
  hash: string;
  files: number;
  symbols: number;
  high_trust_memory: number;
  stale_or_low_memory: number;
}

export interface RepoGuidanceAreaDrift {
  metadata_found: boolean;
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
}

export interface GenerateRepoSkillsResponse {
  ok: true;
  target_path: string;
  generated_files: string[];
  wrote: boolean;
  current: boolean;
  source: SourceIndexStatus;
  summary: {
    graph_nodes: number;
    source_files: number;
    source_symbols: number;
    areas: string[];
    area_files: RepoGuidanceAreaSummary[];
    area_drift: RepoGuidanceAreaDrift;
  };
  warnings: string[];
  next_steps: string[];
}

interface GeneratedRepoFile {
  path: string;
  body: string;
  areaName?: string;
}

interface RepoSkillRender {
  body: string;
  files: GeneratedRepoFile[];
  sourceStatus: SourceIndexStatus;
  graphNodeCount: number;
  areas: RepoSkillArea[];
  areaHashes: Record<string, string>;
  staleOrLowMemoryCount: number;
}

interface RepoSkillArea {
  name: string;
  slug: string;
  filePath: string;
  hash: string;
  files: IndexedSourceFile[];
  symbols: number;
  exports: Array<SourceSymbol & { file_path: string }>;
  memory: RepoSkillMemory[];
  highTrustMemory: RepoSkillMemory[];
  staleOrLowMemory: number;
  body: string;
}

interface RepoSkillMemory {
  id: string;
  kind: Node["kind"];
  name: string;
  trust: GraphMemoryTrust;
  freshness: GraphMemoryFreshness;
  confidence: number;
  sourceAreas: string[];
  staleSources: number;
}

export async function generateRepoSkills(
  repoRoot: string,
  options: GenerateRepoSkillsOptions = {},
): Promise<GenerateRepoSkillsResponse & { content?: string }> {
  const targetPath = path.resolve(repoRoot, options.outputPath ?? DEFAULT_OUTPUT);
  const render = await repoSkillRender(repoRoot, targetPath);
  const existingMain = await readOptional(targetPath);
  const current = await generatedFilesCurrent(render.files);
  const areaDrift = compareAreaHashes(
    parseAreaHashes(existingMain),
    render.areaHashes,
  );
  const warnings: string[] = [];

  if (!render.sourceStatus.indexed) {
    warnings.push("Source index is missing; generated repo skill has limited source-area detail.");
  } else if (!render.sourceStatus.fresh) {
    warnings.push("Source index is stale; generated repo skill may describe old source structure.");
  }
  if (render.staleOrLowMemoryCount > 0) {
    warnings.push(
      `${render.staleOrLowMemoryCount} curated graph memories are stale or low-trust; generated guidance marks them as inspect-first.`,
    );
  }

  let wrote = false;
  if (!options.check && !options.stdout && !current) {
    await writeGeneratedFiles(render.files);
    wrote = true;
  }

  const response = {
    ok: true as const,
    target_path: path.relative(repoRoot, targetPath),
    generated_files: render.files.map((file) => path.relative(repoRoot, file.path)),
    wrote,
    current,
    source: render.sourceStatus,
    summary: {
      graph_nodes: render.graphNodeCount,
      source_files: render.sourceStatus.files_indexed,
      source_symbols: render.sourceStatus.symbols_indexed,
      areas: render.areas.map((area) => area.name),
      area_files: render.areas.map((area) => ({
        name: area.name,
        file_path: path.relative(repoRoot, area.filePath),
        hash: area.hash,
        files: area.files.length,
        symbols: area.symbols,
        high_trust_memory: area.highTrustMemory.length,
        stale_or_low_memory: area.staleOrLowMemory,
      })),
      area_drift: areaDrift,
    },
    warnings,
    next_steps: repoSkillNextSteps({
      check: options.check ?? false,
      stdout: options.stdout ?? false,
      current,
      wrote,
      sourceStatus: render.sourceStatus,
      areaDrift,
    }),
  };

  return options.stdout ? { ...response, content: render.body } : response;
}

async function repoSkillRender(
  repoRoot: string,
  targetPath: string,
): Promise<RepoSkillRender> {
  const projectName = path.basename(path.resolve(repoRoot));
  const sourceStatus = await getSourceIndexStatus(repoRoot);
  const index = await loadSourceIndex(repoRoot);
  const graph = await GraphStore.load(repoRoot);
  const files = Object.values(index?.files ?? {});
  const graphNodes = graph.listNodes();
  const graphStaleness = await checkSourceStaleness(repoRoot, graphNodes);
  const memory = graphNodes
    .filter((node) => DURABLE_MEMORY_KINDS.has(node.kind))
    .map((node) => {
      const quality = scoreGraphMemoryQuality(node, graphStaleness);
      return {
        id: node.id,
        kind: node.kind,
        name: node.name,
        trust: quality.trust,
        freshness: quality.freshness,
        confidence: node.confidence,
        sourceAreas: sourceAreasForNode(node),
        staleSources: quality.stale_sources,
      };
    })
    .sort(memorySort);
  const outputDir = path.dirname(targetPath);
  const areas = buildAreas({
    files,
    memory,
    outputDir,
    sourceStatus,
  });
  const areaHashes = Object.fromEntries(
    areas.map((area) => [area.name, area.hash]),
  );
  const highTrustMemory = memory
    .filter((item) => item.trust === "high")
    .slice(0, GLOBAL_MEMORY_LIMIT);
  const staleOrLowMemoryCount = memory.filter(
    (item) => item.trust === "low" || item.freshness === "stale",
  ).length;
  const contentHash = hashJson({
    version: packageJson.version,
    source: sourceStatus.updated_at ?? null,
    source_fresh: sourceStatus.fresh,
    files: sourceStatus.files_indexed,
    symbols: sourceStatus.symbols_indexed,
    area_hashes: areaHashes,
    high_trust_memory: highTrustMemory.map((item) => item.id),
    stale_or_low_memory: staleOrLowMemoryCount,
  });

  const body = `---
name: codemap-repo-context
description: Generated Codemap repo context for ${projectName}. Use for repository tasks only; regenerate with codemap generate-skills.
---

# Codemap Repo Context: ${projectName}

<!-- codemap:generated-skill version=${packageJson.version} hash=${contentHash} -->
<!-- codemap:area-hashes ${JSON.stringify(areaHashes)} -->

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

## Provenance

- generated_at_source_index: ${sourceStatus.updated_at ?? "not indexed"}
- source_index_fresh: ${sourceStatus.fresh}
- source_files: ${sourceStatus.files_indexed}
- source_symbols: ${sourceStatus.symbols_indexed}
- graph_nodes: ${graph.listNodes({ includeDeprecated: true }).length}
- high_trust_memory_used: ${highTrustMemory.length}
- stale_or_low_trust_memory_noted: ${staleOrLowMemoryCount}

## Repo Area Slices

${areas.length > 0 ? areas.map(areaSummaryLine).join("\n") : "- No indexed source areas yet. Run codemap scan, then regenerate."}

## High-Trust Curated Memory

${highTrustMemory.length > 0 ? highTrustMemory.map(memoryLine).join("\n") : "- No high-trust decision/invariant/gotcha memory is currently available. Use query_context and inspect source files."}

## Boundaries

- Area files are generated orientation and may be stale.
- Area hashes are included so codemap generate-skills --check can report drift.
- Prefer fresh graph nodes and inspected files over generated text.
- For unrelated Q&A, web research, installs, or recommendations, do not use Codemap.
`;
  return {
    body,
    files: [
      { path: targetPath, body },
      ...areas.map((area) => ({ path: area.filePath, body: area.body, areaName: area.name })),
    ],
    sourceStatus,
    graphNodeCount: graph.listNodes({ includeDeprecated: true }).length,
    areas,
    areaHashes,
    staleOrLowMemoryCount,
  };
}

function buildAreas(input: {
  files: IndexedSourceFile[];
  memory: RepoSkillMemory[];
  outputDir: string;
  sourceStatus: SourceIndexStatus;
}): RepoSkillArea[] {
  const byArea = new Map<string, IndexedSourceFile[]>();
  for (const file of input.files) {
    const area = areaNameForPath(file.file_path);
    const current = byArea.get(area) ?? [];
    current.push(file);
    byArea.set(area, current);
  }

  return [...byArea.entries()]
    .map(([name, files]) => {
      const slug = slugAreaName(name);
      const exports = summarizeExports(files, AREA_EXPORT_LIMIT);
      const relevantMemory = input.memory.filter((item) =>
        item.sourceAreas.includes(name),
      );
      const highTrustMemory = relevantMemory
        .filter((item) => item.trust === "high")
        .slice(0, AREA_MEMORY_LIMIT);
      const staleOrLowMemory = relevantMemory.filter(
        (item) => item.trust === "low" || item.freshness === "stale",
      ).length;
      const sortedFiles = files.sort(
        (a, b) =>
          b.symbols.length - a.symbols.length ||
          b.exports.length - a.exports.length ||
          a.file_path.localeCompare(b.file_path),
      );
      const symbols = files.reduce((sum, file) => sum + file.symbols.length, 0);
      const hash = hashJson({
        name,
        source_updated_at: input.sourceStatus.updated_at ?? null,
        source_fresh: input.sourceStatus.fresh,
        files: sortedFiles.map((file) => ({
          path: file.file_path,
          hash: file.content_hash,
          symbols: file.symbols.map((symbol) => [
            symbol.name,
            symbol.kind,
            symbol.exported,
          ]),
          exports: file.exports,
        })),
        memory: relevantMemory.map((item) => ({
          id: item.id,
          trust: item.trust,
          freshness: item.freshness,
          stale_sources: item.staleSources,
        })),
      });
      const filePath = path.join(input.outputDir, "areas", `${slug}.md`);
      const area: RepoSkillArea = {
        name,
        slug,
        filePath,
        hash,
        files: sortedFiles,
        symbols,
        exports,
        memory: relevantMemory,
        highTrustMemory,
        staleOrLowMemory,
        body: "",
      };
      area.body = renderAreaBody(area, input.sourceStatus);
      return area;
    })
    .sort(
      (a, b) =>
        b.files.length - a.files.length ||
        b.symbols - a.symbols ||
        a.name.localeCompare(b.name),
    )
    .slice(0, AREA_LIMIT);
}

function renderAreaBody(
  area: RepoSkillArea,
  sourceStatus: SourceIndexStatus,
): string {
  return `# Codemap Area: ${area.name}

<!-- codemap:area name=${area.name} hash=${area.hash} -->

This file is generated orientation for one repo area. Treat it as a pointer to
inspect real files, not as proof or durable graph memory.

## Provenance

- area_hash: ${area.hash}
- source_index_fresh: ${sourceStatus.fresh}
- source_index_updated_at: ${sourceStatus.updated_at ?? "not indexed"}
- files: ${area.files.length}
- symbols: ${area.symbols}
- high_trust_memory: ${area.highTrustMemory.length}
- stale_or_low_trust_memory: ${area.staleOrLowMemory}

## Inspect First

${area.files.length > 0 ? area.files.slice(0, AREA_FILE_LIMIT).map(fileLine).join("\n") : "- No indexed files in this area."}

## Exports To Recognize

${area.exports.length > 0 ? area.exports.map(exportLine).join("\n") : "- No exported symbols found for this area."}

## High-Trust Curated Memory

${area.highTrustMemory.length > 0 ? area.highTrustMemory.map(memoryLine).join("\n") : "- No high-trust curated memory for this area. Use query_context and inspect source files."}

## Inspect-First Signals

${area.staleOrLowMemory > 0 ? `- ${area.staleOrLowMemory} related graph memories are stale or low-trust; inspect their source anchors before relying on them.` : "- No stale or low-trust related graph memory was found for this area."}
- Generated from source index and graph summaries only.
- Never emit graph nodes from this file without re-reading project files.
`;
}

function areaSummaryLine(area: RepoSkillArea): string {
  return `- ${area.name}: [areas/${area.slug}.md](areas/${area.slug}.md), ${area.files.length} files, ${area.symbols} symbols, high_trust_memory=${area.highTrustMemory.length}, hash=${area.hash}`;
}

function fileLine(file: IndexedSourceFile): string {
  const exports = file.exports.length > 0
    ? `; exports ${file.exports.slice(0, 5).join(", ")}`
    : "";
  return `- ${file.file_path}: ${file.symbols.length} symbols${exports}`;
}

function exportLine(entry: SourceSymbol & { file_path: string }): string {
  return `- ${entry.name} (${entry.kind}) in ${entry.file_path}:${entry.name_line ?? entry.line}`;
}

function memoryLine(item: RepoSkillMemory): string {
  return `- ${item.id} (${item.kind}, ${item.trust}, ${item.freshness}, confidence ${item.confidence.toFixed(2)}): ${item.name}`;
}

function summarizeExports(
  files: IndexedSourceFile[],
  limit: number,
): Array<SourceSymbol & { file_path: string }> {
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
    .slice(0, limit);
}

async function generatedFilesCurrent(files: GeneratedRepoFile[]): Promise<boolean> {
  const checks = await Promise.all(
    files.map(async (file) => (await readOptional(file.path)) === file.body),
  );
  return checks.every(Boolean);
}

async function writeGeneratedFiles(files: GeneratedRepoFile[]): Promise<void> {
  for (const file of files) {
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.body, "utf8");
  }
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseAreaHashes(content: string | null): Record<string, string> | null {
  if (!content) return null;
  const match = content.match(AREA_HASHES_RE);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    return null;
  }
}

function compareAreaHashes(
  previous: Record<string, string> | null,
  current: Record<string, string>,
): RepoGuidanceAreaDrift {
  if (!previous) {
    return {
      metadata_found: false,
      added: Object.keys(current).sort(),
      changed: [],
      removed: [],
      unchanged: [],
    };
  }

  const allNames = new Set([...Object.keys(previous), ...Object.keys(current)]);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const name of [...allNames].sort()) {
    if (!(name in previous)) {
      added.push(name);
    } else if (!(name in current)) {
      removed.push(name);
    } else if (previous[name] === current[name]) {
      unchanged.push(name);
    } else {
      changed.push(name);
    }
  }
  return { metadata_found: true, added, changed, removed, unchanged };
}

function repoSkillNextSteps(input: {
  check: boolean;
  stdout: boolean;
  current: boolean;
  wrote: boolean;
  sourceStatus: SourceIndexStatus;
  areaDrift: RepoGuidanceAreaDrift;
}): string[] {
  const steps: string[] = [];
  if (!input.sourceStatus.indexed) {
    steps.push("Run codemap scan before generating richer repo guidance.");
  } else if (!input.sourceStatus.fresh) {
    steps.push("Refresh the source index before relying on generated repo guidance.");
  }
  if (input.check && !input.current) {
    const changed = [
      ...input.areaDrift.added,
      ...input.areaDrift.changed,
      ...input.areaDrift.removed,
    ];
    const suffix = changed.length > 0 ? ` Changed areas: ${changed.join(", ")}.` : "";
    steps.push(`Regenerate with codemap generate-skills.${suffix}`);
  }
  if (input.wrote) {
    steps.push("Tell agents this folder is generated orientation, not durable memory.");
  }
  if (input.stdout) {
    steps.push("Review the generated guidance before writing it to disk.");
  }
  if (steps.length === 0) {
    steps.push("Generated repo guidance is current.");
  }
  return steps;
}

function sourceAreasForNode(node: Node): string[] {
  const areas = new Set(node.sources.map((source) => areaNameForPath(source.file_path)));
  for (const tag of node.tags) {
    if (tag && !["decision", "gotcha", "invariant"].includes(tag)) {
      areas.add(tag);
    }
  }
  return [...areas].sort();
}

function areaNameForPath(filePath: string): string {
  return filePath.includes("/") ? filePath.split("/")[0] ?? filePath : ".";
}

function slugAreaName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "root";
}

function memorySort(a: RepoSkillMemory, b: RepoSkillMemory): number {
  return (
    trustRank(b.trust) - trustRank(a.trust) ||
    freshnessRank(b.freshness) - freshnessRank(a.freshness) ||
    b.confidence - a.confidence ||
    a.id.localeCompare(b.id)
  );
}

function trustRank(trust: GraphMemoryTrust): number {
  if (trust === "high") return 3;
  if (trust === "medium") return 2;
  return 1;
}

function freshnessRank(freshness: GraphMemoryFreshness): number {
  if (freshness === "fresh") return 4;
  if (freshness === "unchecked") return 3;
  if (freshness === "no_sources") return 2;
  return 1;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}
