import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { GraphStore } from "./graph.js";
import {
  buildWritebackSuggestions,
  type WritebackSuggestionResponse,
} from "./writeback_suggestions.js";
import { checkSourceStaleness, type StaleSource } from "./staleness.js";
import {
  getSourceIndexStatus,
  loadSourceIndex,
  scanSourceIndex,
  searchSourceIndex,
  type SourceDependencyContext,
  type SourceImpactContext,
  type SourceIndexStatus,
  type SourceSearchResult,
  type SourceSymbol,
} from "./source_index.js";
import type { Node } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_FILE_LIMIT = 12;
const DEFAULT_DEPENDENCY_LIMIT = 3;
const DEFAULT_IMPACT_LIMIT = 5;
const DEFAULT_MAX_CONTENT_CHARS = 1200;

export type ChangesRefreshMode = "never" | "if_missing" | "if_stale";
export type ChangedFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "untracked";
export type ChangeRisk = "low" | "medium" | "high";

export interface ChangedRange {
  start_line: number;
  end_line: number;
  source: "base" | "staged" | "unstaged" | "untracked";
}

export interface AffectedPath {
  file_path: string;
  reason: string;
}

export interface ChangedFileContext {
  file_path: string;
  status: ChangedFileStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  deleted: boolean;
  changed_ranges: ChangedRange[];
  indexed: boolean;
  changed_symbols: SourceSymbol[];
  related_graph_nodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>;
  dependency_context: SourceDependencyContext[];
  impact_context?: SourceImpactContext;
  warnings: string[];
}

export interface ChangesContextOptions {
  /** Compare this ref against HEAD instead of the working tree. */
  baseRef?: string;
  includeUntracked?: boolean;
  refreshIndex?: ChangesRefreshMode;
  fileLimit?: number;
  dependencyLimit?: number;
  impactLimit?: number;
  maxContentChars?: number;
  includeWriteback?: boolean;
}

export interface ChangesContextResponse {
  ok: true;
  mode: "working_tree" | "base_ref";
  base_ref?: string;
  git: {
    repo_root: string;
    has_changes: boolean;
    changed_files: number;
  };
  source: {
    status: SourceIndexStatus;
    refreshed: boolean;
  };
  summary: {
    risk: ChangeRisk;
    changed_files: number;
    changed_symbols: number;
    stale_graph_nodes: number;
    likely_affected_files: number;
    likely_tests: number;
    likely_docs: number;
  };
  files: ChangedFileContext[];
  stale_graph_nodes: Array<
    Pick<Node, "id" | "kind" | "name" | "summary"> & {
      stale_sources: StaleSource[];
    }
  >;
  likely_affected_files: string[];
  likely_tests: AffectedPath[];
  likely_docs: AffectedPath[];
  writeback: WritebackSuggestionResponse | null;
  warnings: string[];
  next_steps: string[];
}

interface ChangedFileAccumulator {
  file_path: string;
  status: ChangedFileStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  deleted: boolean;
  ranges: ChangedRange[];
}

type GitDiffSource = "base" | "staged" | "unstaged";

export async function buildChangesContext(
  repoRoot: string,
  options: ChangesContextOptions = {},
): Promise<ChangesContextResponse> {
  const resolvedRoot = path.resolve(repoRoot);
  const refreshIndex = options.refreshIndex ?? "if_missing";
  const fileLimit = options.fileLimit ?? DEFAULT_FILE_LIMIT;
  const dependencyLimit = options.dependencyLimit ?? DEFAULT_DEPENDENCY_LIMIT;
  const impactLimit = options.impactLimit ?? DEFAULT_IMPACT_LIMIT;
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const includeUntracked = options.includeUntracked ?? true;
  const includeWriteback = options.includeWriteback ?? true;
  const warnings: string[] = [];

  await assertGitRepo(resolvedRoot);

  let sourceStatus = await getSourceIndexStatus(resolvedRoot);
  let refreshed = false;
  const shouldRefresh =
    refreshIndex === "if_stale"
      ? !sourceStatus.indexed || !sourceStatus.fresh
      : refreshIndex === "if_missing" && !sourceStatus.indexed;
  if (shouldRefresh) {
    try {
      await scanSourceIndex(resolvedRoot);
      refreshed = true;
      sourceStatus = await getSourceIndexStatus(resolvedRoot);
    } catch (err) {
      warnings.push(`Source index refresh failed: ${String(err)}`);
    }
  }

  if (!sourceStatus.indexed) {
    warnings.push(
      "Source index is missing; impact mapping is limited until codemap scan or index_codebase runs.",
    );
  } else if (!sourceStatus.fresh) {
    warnings.push(
      "Source index is stale; change impact is best-effort until codemap scan or index_codebase refreshes it.",
    );
  }

  const changedFiles = await collectChangedFiles(resolvedRoot, {
    baseRef: options.baseRef,
    includeUntracked,
  });
  const limitedChangedFiles = changedFiles.slice(0, fileLimit);
  if (changedFiles.length > limitedChangedFiles.length) {
    warnings.push(
      `Change context is capped at ${fileLimit} files; ${changedFiles.length - limitedChangedFiles.length} changed files were omitted.`,
    );
  }

  const index = await loadSourceIndex(resolvedRoot);
  const graphNodesByFile = await graphNodesBySourceFile(resolvedRoot);
  const files: ChangedFileContext[] = [];
  const likelyAffectedFiles = new Set<string>();

  for (const changed of limitedChangedFiles) {
    const indexedFile = index?.files[changed.file_path];
    const sourceHit = indexedFile
      ? await sourceImpactForFile(resolvedRoot, changed.file_path, {
          dependencyLimit,
          impactLimit,
          maxContentChars,
        })
      : null;
    const changedSymbols = indexedFile
      ? symbolsInChangedRanges(indexedFile.symbols, changed.ranges)
      : [];
    const impact = sourceHit?.impact_context;
    for (const filePath of impact?.likely_affected_files ?? []) {
      if (filePath !== changed.file_path) likelyAffectedFiles.add(filePath);
    }
    for (const reference of impact?.imported_by ?? []) {
      if (reference.file_path !== changed.file_path) {
        likelyAffectedFiles.add(reference.file_path);
      }
    }

    files.push({
      file_path: changed.file_path,
      status: changed.status,
      staged: changed.staged,
      unstaged: changed.unstaged,
      untracked: changed.untracked,
      deleted: changed.deleted,
      changed_ranges: changed.ranges,
      indexed: indexedFile !== undefined,
      changed_symbols: changedSymbols,
      related_graph_nodes: graphNodesByFile.get(changed.file_path) ?? [],
      dependency_context: sourceHit?.dependency_context ?? [],
      impact_context: impact,
      warnings: fileWarnings(changed, indexedFile !== undefined, sourceHit),
    });
  }

  const changedFilePaths = limitedChangedFiles.map((file) => file.file_path);
  const staleGraphNodes = await staleGraphNodesForFiles(
    resolvedRoot,
    graphNodesByFile,
    changedFilePaths,
  );
  const allKnownPaths = await listRepoFiles(resolvedRoot);
  const testCandidates = likelyTests(
    changedFilePaths,
    likelyAffectedFiles,
    allKnownPaths,
  );
  const docCandidates = likelyDocs(
    changedFilePaths,
    likelyAffectedFiles,
    allKnownPaths,
  );
  const writeback = includeWriteback
    ? await buildWritebackSuggestions(resolvedRoot, {
        modifiedFiles: changedFilePaths,
        workSummary: `Review changed files for behavior, tests, stale memory, decisions, and gotchas: ${changedFilePaths.join(", ")}`,
        includeGit: false,
        limit: 4,
      })
    : null;

  const changedSymbolCount = files.reduce(
    (sum, file) => sum + file.changed_symbols.length,
    0,
  );
  const risk = riskLevel({
    changedFiles: changedFiles.length,
    staleGraphNodes: staleGraphNodes.length,
    likelyAffectedFiles: likelyAffectedFiles.size,
    deletedFiles: limitedChangedFiles.filter((file) => file.deleted).length,
  });

  return {
    ok: true,
    mode: options.baseRef ? "base_ref" : "working_tree",
    base_ref: options.baseRef,
    git: {
      repo_root: resolvedRoot,
      has_changes: changedFiles.length > 0,
      changed_files: changedFiles.length,
    },
    source: {
      status: sourceStatus,
      refreshed,
    },
    summary: {
      risk,
      changed_files: changedFiles.length,
      changed_symbols: changedSymbolCount,
      stale_graph_nodes: staleGraphNodes.length,
      likely_affected_files: likelyAffectedFiles.size,
      likely_tests: testCandidates.length,
      likely_docs: docCandidates.length,
    },
    files,
    stale_graph_nodes: staleGraphNodes,
    likely_affected_files: [...likelyAffectedFiles].sort(),
    likely_tests: testCandidates,
    likely_docs: docCandidates,
    writeback,
    warnings,
    next_steps: nextSteps({
      hasChanges: changedFiles.length > 0,
      sourceStatus,
      staleGraphNodes: staleGraphNodes.length,
      writebackSuggestions: writeback?.total_suggestions ?? 0,
    }),
  };
}

async function assertGitRepo(repoRoot: string): Promise<void> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
    });
  } catch {
    throw new Error("changes_context requires a git repository");
  }
}

async function collectChangedFiles(
  repoRoot: string,
  options: { baseRef?: string; includeUntracked: boolean },
): Promise<ChangedFileAccumulator[]> {
  const byPath = new Map<string, ChangedFileAccumulator>();

  if (options.baseRef) {
    await addNameStatus(repoRoot, byPath, "base", [
      "diff",
      "--name-status",
      "--no-renames",
      `${options.baseRef}...HEAD`,
    ]);
    await addRanges(repoRoot, byPath, "base", [
      "diff",
      "--unified=0",
      "--no-renames",
      `${options.baseRef}...HEAD`,
    ]);
  } else {
    await addNameStatus(repoRoot, byPath, "staged", [
      "diff",
      "--cached",
      "--name-status",
      "--no-renames",
    ]);
    await addNameStatus(repoRoot, byPath, "unstaged", [
      "diff",
      "--name-status",
      "--no-renames",
    ]);
    await addRanges(repoRoot, byPath, "staged", [
      "diff",
      "--cached",
      "--unified=0",
      "--no-renames",
    ]);
    await addRanges(repoRoot, byPath, "unstaged", [
      "diff",
      "--unified=0",
      "--no-renames",
    ]);
    if (options.includeUntracked) {
      await addUntracked(repoRoot, byPath);
    }
  }

  return [...byPath.values()].sort((a, b) => a.file_path.localeCompare(b.file_path));
}

async function addNameStatus(
  repoRoot: string,
  byPath: Map<string, ChangedFileAccumulator>,
  source: GitDiffSource,
  args: string[],
): Promise<void> {
  const output = await gitOutput(repoRoot, args);
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const statusCode = parts[0] ?? "";
    const filePath = normalizeGitPath(parts.at(-1) ?? "");
    if (!filePath || isGeneratedCodemapPath(filePath)) continue;
    const entry = ensureChangedFile(byPath, filePath);
    entry.status = statusFromCode(statusCode, entry.status);
    entry.deleted = entry.deleted || statusCode.startsWith("D");
    entry.staged = entry.staged || source === "staged";
    entry.unstaged = entry.unstaged || source === "unstaged";
  }
}

async function addRanges(
  repoRoot: string,
  byPath: Map<string, ChangedFileAccumulator>,
  source: GitDiffSource,
  args: string[],
): Promise<void> {
  const output = await gitOutput(repoRoot, args);
  let currentPath: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentPath = parseNewFilePath(line);
      if (currentPath && isGeneratedCodemapPath(currentPath)) {
        currentPath = null;
      }
      continue;
    }
    if (!currentPath || !line.startsWith("@@")) continue;
    const range = parseUnifiedRange(line);
    if (!range) continue;
    ensureChangedFile(byPath, currentPath).ranges.push({
      ...range,
      source,
    });
  }
}

async function addUntracked(
  repoRoot: string,
  byPath: Map<string, ChangedFileAccumulator>,
): Promise<void> {
  const output = await gitOutput(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  for (const line of output.split("\n")) {
    const filePath = normalizeGitPath(line);
    if (!filePath || isGeneratedCodemapPath(filePath)) continue;
    const entry = ensureChangedFile(byPath, filePath);
    entry.status = "untracked";
    entry.untracked = true;
    const lineCount = await fileLineCount(path.join(repoRoot, filePath));
    entry.ranges.push({
      start_line: 1,
      end_line: Math.max(1, lineCount),
      source: "untracked",
    });
  }
}

async function gitOutput(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

function ensureChangedFile(
  byPath: Map<string, ChangedFileAccumulator>,
  filePath: string,
): ChangedFileAccumulator {
  let entry = byPath.get(filePath);
  if (!entry) {
    entry = {
      file_path: filePath,
      status: "modified",
      staged: false,
      unstaged: false,
      untracked: false,
      deleted: false,
      ranges: [],
    };
    byPath.set(filePath, entry);
  }
  return entry;
}

function statusFromCode(
  statusCode: string,
  fallback: ChangedFileStatus,
): ChangedFileStatus {
  if (statusCode.startsWith("A")) return "added";
  if (statusCode.startsWith("D")) return "deleted";
  if (statusCode.startsWith("R")) return "renamed";
  if (statusCode.startsWith("??")) return "untracked";
  if (fallback === "added" || fallback === "deleted" || fallback === "renamed") {
    return fallback;
  }
  return "modified";
}

function normalizeGitPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed === "/dev/null") return "";
  return trimmed.replace(/\\/g, "/");
}

function isGeneratedCodemapPath(filePath: string): boolean {
  return (
    filePath.startsWith(".codemap/index/") ||
    filePath.startsWith(".codemap/skills/")
  );
}

function parseNewFilePath(line: string): string | null {
  const value = line.slice(4).trim();
  if (value === "/dev/null") return null;
  if (value.startsWith("b/")) return normalizeGitPath(value.slice(2));
  return normalizeGitPath(value);
}

function parseUnifiedRange(line: string): Omit<ChangedRange, "source"> | null {
  const match = line.match(/\+(\d+)(?:,(\d+))?/);
  if (!match?.[1]) return null;
  const start = Math.max(1, Number(match[1]));
  const count = match[2] ? Number(match[2]) : 1;
  return {
    start_line: start,
    end_line: Math.max(start, start + Math.max(1, count) - 1),
  };
}

async function fileLineCount(absolutePath: string): Promise<number> {
  try {
    const content = await fs.readFile(absolutePath, "utf8");
    return content.split(/\r?\n/).length;
  } catch {
    return 1;
  }
}

async function sourceImpactForFile(
  repoRoot: string,
  filePath: string,
  options: {
    dependencyLimit: number;
    impactLimit: number;
    maxContentChars: number;
  },
): Promise<Pick<
  SourceSearchResult,
  "dependency_context" | "impact_context"
> | null> {
  const search = await searchSourceIndex(repoRoot, filePath, {
    limit: 5,
    maxContentChars: options.maxContentChars,
    dependencyLimit: options.dependencyLimit,
    includeImpact: true,
    impactLimit: options.impactLimit,
    impactContentChars: options.maxContentChars,
    dependencyContentChars: Math.min(600, options.maxContentChars),
  });
  if (!search.ok) return null;
  return (
    search.results.find((result) => result.file_path === filePath) ??
    search.results[0] ??
    null
  );
}

function symbolsInChangedRanges(
  symbols: SourceSymbol[],
  ranges: ChangedRange[],
): SourceSymbol[] {
  if (ranges.length === 0) {
    return symbols.filter((symbol) => symbol.exported).slice(0, 8);
  }
  return symbols
    .filter((symbol) =>
      ranges.some(
        (range) =>
          symbol.line >= range.start_line && symbol.line <= range.end_line,
      ),
    )
    .slice(0, 12);
}

function fileWarnings(
  changed: ChangedFileAccumulator,
  indexed: boolean,
  sourceHit: Pick<SourceSearchResult, "impact_context"> | null,
): string[] {
  const warnings: string[] = [];
  if (!indexed && !changed.deleted) {
    warnings.push("Changed file is not present in the source index.");
  }
  if (changed.deleted) {
    warnings.push("Deleted file impact is inferred from old graph/source anchors only.");
  }
  if (indexed && !sourceHit?.impact_context) {
    warnings.push("No impact context was produced for this file.");
  }
  return warnings;
}

async function graphNodesBySourceFile(
  repoRoot: string,
): Promise<Map<string, Array<Pick<Node, "id" | "kind" | "name" | "summary">>>> {
  const store = await GraphStore.load(repoRoot);
  const byFile = new Map<
    string,
    Array<Pick<Node, "id" | "kind" | "name" | "summary">>
  >();
  for (const node of store.listNodes({ includeDeprecated: true })) {
    for (const source of node.sources) {
      const existing = byFile.get(source.file_path) ?? [];
      existing.push({
        id: node.id,
        kind: node.kind,
        name: node.name,
        summary: node.summary,
      });
      byFile.set(source.file_path, existing);
    }
  }
  return byFile;
}

async function staleGraphNodesForFiles(
  repoRoot: string,
  graphNodesByFile: Map<
    string,
    Array<Pick<Node, "id" | "kind" | "name" | "summary">>
  >,
  filePaths: string[],
): Promise<
  Array<Pick<Node, "id" | "kind" | "name" | "summary"> & {
    stale_sources: StaleSource[];
  }>
> {
  const store = await GraphStore.load(repoRoot);
  const nodeIds = new Set<string>();
  for (const filePath of filePaths) {
    for (const node of graphNodesByFile.get(filePath) ?? []) {
      nodeIds.add(node.id);
    }
  }
  const nodes = [...nodeIds]
    .map((id) => store.getNode(id))
    .filter((node): node is Node => node !== null);
  const staleness = await checkSourceStaleness(repoRoot, nodes);
  const staleByNode = new Map<string, StaleSource[]>();
  for (const source of staleness.stale_sources) {
    const existing = staleByNode.get(source.node_id) ?? [];
    existing.push(source);
    staleByNode.set(source.node_id, existing);
  }
  return nodes
    .filter((node) => staleByNode.has(node.id))
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      summary: node.summary,
      stale_sources: staleByNode.get(node.id) ?? [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function listRepoFiles(repoRoot: string): Promise<string[]> {
  try {
    const output = await gitOutput(repoRoot, ["ls-files"]);
    return output
      .split("\n")
      .map(normalizeGitPath)
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function likelyTests(
  changedFilePaths: string[],
  affectedFilePaths: Set<string>,
  allFiles: string[],
): AffectedPath[] {
  const bases = new Set(
    [...changedFilePaths, ...affectedFilePaths].map((filePath) =>
      path.basename(filePath).replace(/\.[^.]+$/, "").toLowerCase(),
    ),
  );
  return allFiles
    .filter(isTestFile)
    .filter((filePath) => {
      const lower = filePath.toLowerCase();
      return [...bases].some((base) => base && lower.includes(base));
    })
    .slice(0, 12)
    .map((file_path) => ({
      file_path,
      reason: "test filename resembles a changed or impacted file",
    }));
}

function likelyDocs(
  changedFilePaths: string[],
  affectedFilePaths: Set<string>,
  allFiles: string[],
): AffectedPath[] {
  const touchedDocs = new Set(
    [...changedFilePaths, ...affectedFilePaths].filter(isDocFile),
  );
  const generalDocs = allFiles.filter((filePath) =>
    ["README.md", "TECH_SPEC.md", "V1_SPEC.md", "ROADMAP.md"].includes(filePath),
  );
  return [...new Set([...touchedDocs, ...generalDocs])]
    .slice(0, 10)
    .map((file_path) => ({
      file_path,
      reason: touchedDocs.has(file_path)
        ? "documentation file changed or is directly impacted"
        : "top-level product documentation may need updates for behavior changes",
    }));
}

function isTestFile(filePath: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__)\//.test(filePath) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath)
  );
}

function isDocFile(filePath: string): boolean {
  return (
    /\.(md|mdx|rst|txt)$/.test(filePath) ||
    filePath.startsWith("docs/") ||
    filePath.startsWith("tasks/")
  );
}

function riskLevel(input: {
  changedFiles: number;
  staleGraphNodes: number;
  likelyAffectedFiles: number;
  deletedFiles: number;
}): ChangeRisk {
  if (
    input.deletedFiles > 0 ||
    input.staleGraphNodes > 2 ||
    input.likelyAffectedFiles > 8 ||
    input.changedFiles > 10
  ) {
    return "high";
  }
  if (
    input.staleGraphNodes > 0 ||
    input.likelyAffectedFiles > 0 ||
    input.changedFiles > 3
  ) {
    return "medium";
  }
  return "low";
}

function nextSteps(input: {
  hasChanges: boolean;
  sourceStatus: SourceIndexStatus;
  staleGraphNodes: number;
  writebackSuggestions: number;
}): string[] {
  const steps: string[] = [];
  if (!input.hasChanges) {
    steps.push("No git changes were detected; make or select a diff before using change impact context.");
    return steps;
  }
  if (!input.sourceStatus.indexed) {
    steps.push("Build the source index to improve impact and affected-file mapping.");
  } else if (!input.sourceStatus.fresh) {
    steps.push("Refresh the source index before treating impact context as current.");
  }
  if (input.staleGraphNodes > 0) {
    steps.push("Inspect stale graph nodes anchored to changed files before relying on them.");
  }
  steps.push("Review likely affected tests/docs before committing.");
  if (input.writebackSuggestions > 0) {
    steps.push("Use writeback suggestions only after confirming durable repo-local lessons from real files.");
  }
  return steps;
}
