import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { lock } from "proper-lockfile";
import ts from "typescript";

import { GraphStore } from "./graph.js";
import type { Node } from "./types.js";
import { ensureSeedFile } from "./util/lock.js";

const INDEX_VERSION = 2 as const;
const SEARCH_INDEX_VERSION = 2 as const;
const INDEX_DIR = ".codemap/index";
const INDEX_FILE = "source.json";
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const MAX_REFERENCES_PER_FILE = 2000;

const SUPPORTED_EXTENSIONS = new Map<string, string>([
  [".c", "c"],
  [".cc", "cpp"],
  [".cjs", "javascript"],
  [".cpp", "cpp"],
  [".cs", "csharp"],
  [".cts", "typescript"],
  [".cxx", "cpp"],
  [".go", "go"],
  [".h", "c"],
  [".hh", "cpp"],
  [".hpp", "cpp"],
  [".hxx", "cpp"],
  [".java", "java"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".md", "markdown"],
  [".mdx", "markdown"],
  [".mjs", "javascript"],
  [".mts", "typescript"],
  [".py", "python"],
  [".rs", "rust"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".gradle", "gradle"],
]);
const SUPPORTED_FILENAMES = new Map<string, string>([
  ["build.gradle", "gradle"],
  ["build.gradle.kts", "gradle"],
  ["meson.build", "meson"],
  ["meson_options.txt", "meson"],
  ["settings.gradle", "gradle"],
  ["settings.gradle.kts", "gradle"],
]);
const TEST_COMPANION_EXTENSIONS = [
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".cxx",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
];

const SKIP_DIRS = new Set([
  ".cache",
  ".codemap",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const GENERATED_PATTERNS = [
  /\.bundle\.[cm]?[jt]sx?$/,
  /\.d\.ts$/,
  /\.generated\./,
  /\.gen\./,
  /\.min\.[cm]?[jt]s$/,
  /\.map$/,
  /(^|\/)__generated__(\/|$)/,
  /(^|\/)generated(\/|$)/,
];
const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "before",
  "by",
  "can",
  "for",
  "from",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "with",
  "without",
]);
const ARCHIVAL_TOKENS = new Set([
  "archive",
  "archived",
  "archives",
  "deprecated",
  "legacy",
  "obsolete",
]);
const IMPACT_REVIEW_TOKENS = new Set([
  "affected",
  "affects",
  "change",
  "changes",
  "changing",
  "files",
  "impact",
  "implementation",
  "implementations",
  "review",
  "reviews",
  "test",
  "tests",
  "touch",
  "touches",
  "touching",
]);
const GENERIC_PATH_TOKENS = new Set([
  "app",
  "index",
  "lib",
  "source",
  "src",
  "test",
  "tests",
]);
const ARCHIVAL_DEMOTION_MULTIPLIER = 0.05;
const DISCONNECTED_IMPACT_MULTIPLIER = 0.08;
const LOW_COVERAGE_BM25_ONLY_MULTIPLIER = 0.2;
const LOCAL_ROOT_IMPORT_PREFIXES = ["src/", "packages/", "apps/", "libs/"];
const MAX_COMPANION_CONTEXT_CANDIDATES = 4;
const COMPANION_SCORE_MULTIPLIER = 0.72;
const COMPANION_SCORE_FLOOR = 0.25;
const COMPANION_SCORE_DIRECT_CEILING_MULTIPLIER = 0.999_999;
const AGENT_GUIDANCE_QUERY_TOKENS = new Set([
  "agent",
  "agents",
  "contract",
  "emit",
  "graph",
  "guidance",
  "instruction",
  "instructions",
  "lifecycle",
  "memory",
  "node",
  "research",
  "repo",
  "repository",
  "unrelated",
  "writeback",
]);
const WRITEBACK_QUERY_TOKENS = new Set([
  "suggest",
  "suggest_writeback",
  "writeback",
  "writebacks",
]);
const AGENT_GUIDANCE_SEED_FILES = new Set([
  "src/instructions.ts",
  "src/setup.ts",
  "src/cli/init.ts",
  "src/tools/suggest_writeback.ts",
]);
const TASK_INDEX_QUERY_TOKENS = new Set([
  "benchmark",
  "benchmarks",
  "docs",
  "documentation",
  "plan",
  "roadmap",
  "task",
  "tasks",
]);

export interface SourceSymbol {
  name: string;
  kind: "class" | "const" | "enum" | "function" | "interface" | "type";
  line: number;
  name_line?: number;
  end_line?: number;
  exported: boolean;
}

export interface SourceImport {
  module: string;
  line: number;
  end_line?: number;
}

export interface SourceReference {
  name: string;
  start_line: number;
  end_line: number;
}

export type SourceDependencyDirection = "imports" | "imported_by";

export interface SourceDependencyContext {
  direction: SourceDependencyDirection;
  file_path: string;
  module: string;
  import_line: number;
  symbols: SourceSymbol[];
  imports: SourceImport[];
  exports: string[];
  content_preview: string;
}

export type SourceImpactPrecision = "approximate" | "exact";

export type SourceImpactReferenceKind =
  | "definition"
  | "import"
  | "imported_by"
  | "text_reference";

export interface SourceImpactReference {
  kind: SourceImpactReferenceKind;
  precision: SourceImpactPrecision;
  file_path: string;
  start_line: number;
  end_line: number;
  reason: string;
  content_preview: string;
  symbol?: SourceSymbol;
  module?: string;
  import_line?: number;
}

export interface SourceImpactTarget {
  type: "file" | "symbol";
  value: string;
  file_path: string;
  ambiguous: boolean;
  matched_symbol?: SourceSymbol;
}

export interface SourceImpactContext {
  target: SourceImpactTarget;
  definitions: SourceImpactReference[];
  imports: SourceImpactReference[];
  imported_by: SourceImpactReference[];
  exported_symbols: SourceSymbol[];
  likely_affected_files: string[];
  approximate_references: SourceImpactReference[];
  warnings: string[];
}

export type SourceMatchField =
  | "bm25"
  | "content"
  | "export"
  | "import"
  | "path"
  | "related_graph_node"
  | "symbol";

export interface SourceMatchReason {
  field: SourceMatchField;
  value: string;
  score: number;
  detail?: string;
}

export type SourceScoreBreakdown = Record<SourceMatchField, number>;

export interface SourceChunk {
  id: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  chunk_type: SourceSymbol["kind"] | "file" | "mixed";
  symbols: SourceSymbol[];
  imports: SourceImport[];
  exports: string[];
  content: string;
  content_hash: string;
}

export interface SourceSearchDocumentStats {
  chunk_id: string;
  content_hash: string;
  length: number;
}

export interface SourceSearchPosting {
  chunk_id: string;
  term_frequency: number;
}

export interface SourceSearchIndex {
  version: typeof SEARCH_INDEX_VERSION;
  document_count: number;
  average_document_length: number;
  document_frequencies: Record<string, number>;
  documents: Record<string, SourceSearchDocumentStats>;
  postings: Record<string, SourceSearchPosting[]>;
}

export interface IndexedSourceFile {
  file_path: string;
  language: string;
  size_bytes: number;
  mtime_ms?: number;
  line_count: number;
  content_hash: string;
  indexed_at: string;
  imports: SourceImport[];
  exports: string[];
  symbols: SourceSymbol[];
  references?: SourceReference[];
  references_truncated?: boolean;
  chunks: SourceChunk[];
}

export interface SourceIndexStats {
  files_indexed: number;
  files_skipped: number;
  chunks_indexed: number;
  symbols_indexed: number;
  bytes_indexed: number;
}

export interface SourceIndex {
  version: typeof INDEX_VERSION;
  created_at: string;
  updated_at: string;
  max_file_bytes: number;
  stats: SourceIndexStats;
  search?: SourceSearchIndex;
  files: Record<string, IndexedSourceFile>;
}

export interface ScanSourceIndexOptions {
  maxFileBytes?: number;
}

export interface SourceIndexStatus {
  indexed: boolean;
  index_path: string;
  updated_at?: string;
  files_indexed: number;
  chunks_indexed: number;
  symbols_indexed: number;
  stale_files: number;
  missing_files: number;
  new_files: number;
  search_indexed: boolean;
  search_index_stale: boolean;
  fresh: boolean;
  error?: { code: string; message: string };
}

export interface SourceSearchResult {
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  chunk_type: SourceChunk["chunk_type"];
  score: number;
  score_breakdown: SourceScoreBreakdown;
  match_reasons: SourceMatchReason[];
  content: string;
  symbols: SourceSymbol[];
  imports: SourceImport[];
  exports: string[];
  related_nodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>;
  dependency_context: SourceDependencyContext[];
  impact_context?: SourceImpactContext;
}

export interface SourceSearchResponse {
  ok: boolean;
  query: string;
  index_updated_at?: string;
  search_time_ms: number;
  total_results: number;
  results: SourceSearchResult[];
  warnings?: string[];
  error?: { code: string; message: string };
}

export interface SourceSearchOptions {
  limit?: number;
  maxContentChars?: number;
  dependencyLimit?: number;
  dependencyContentChars?: number;
  includeImpact?: boolean;
  impactLimit?: number;
  impactContentChars?: number;
  sourceIndex?: SourceIndex;
}

interface CandidateFile {
  file_path: string;
  absolute_path: string;
  language: string;
  size_bytes: number;
  mtime_ms: number;
}

interface ExtractedSourceFacts {
  imports: SourceImport[];
  exports: string[];
  symbols: SourceSymbol[];
  references: SourceReference[];
  references_truncated: boolean;
}

interface ReverseImportReference {
  importer: IndexedSourceFile;
  importEntry: SourceImport;
}

type ReverseImportIndex = Map<string, ReverseImportReference[]>;

interface ImportRelationshipIndex {
  reverseImportIndex: ReverseImportIndex;
  localImportingFiles: Set<string>;
}

interface CandidateFileSearchResult {
  candidates: CandidateFile[];
  skippedCount: number;
}

interface RankedChunk {
  chunk: SourceChunk;
  score: number;
  score_breakdown: SourceScoreBreakdown;
  match_reasons: SourceMatchReason[];
  related_nodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>;
}

interface CompanionCandidate {
  file: IndexedSourceFile;
  reason: string;
  priority: number;
}

interface TestCompanionCandidate {
  filePath: string;
  requiresImportMatch: boolean;
}

interface SearchReadySnapshot {
  chunks: SourceChunk[];
  document_frequencies: Map<string, number>;
  documents: Map<string, SourceSearchDocumentStats>;
  document_count: number;
  average_document_length: number;
  postings: Map<string, SourceSearchPosting[]>;
}

interface SearchReadyInput {
  chunks: SourceChunk[];
  compatibleSearch?: SourceSearchIndex;
}

interface LoadedSourceIndexStatus {
  status: SourceIndexStatus;
  searchReadyInput: SearchReadyInput;
}

const MAX_MATCH_REASONS = 8;
const SEARCH_READY_CACHE_LIMIT = 8;
const searchReadyCache = new Map<string, SearchReadySnapshot>();

export function sourceIndexPath(repoRoot: string): string {
  return path.join(repoRoot, INDEX_DIR, INDEX_FILE);
}

export async function loadSourceIndex(
  repoRoot: string,
): Promise<SourceIndex | null> {
  const indexPath = sourceIndexPath(repoRoot);
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as SourceIndex;
    if (parsed.version !== INDEX_VERSION || !parsed.files || !parsed.stats) {
      throw new Error(`unsupported source index at ${indexPath}`);
    }
    return parsed;
  } catch (err) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

export async function scanSourceIndex(
  repoRoot: string,
  options: ScanSourceIndexOptions = {},
): Promise<SourceIndex> {
  const now = new Date().toISOString();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const { candidates, skippedCount } = await findCandidateFiles(
    repoRoot,
    { maxFileBytes },
  );
  const files: Record<string, IndexedSourceFile> = {};
  let chunksIndexed = 0;
  let symbolsIndexed = 0;
  let bytesIndexed = 0;

  for (const candidate of candidates) {
    const content = await fs.readFile(candidate.absolute_path, "utf8");
    const indexed = indexFile(candidate, content, now);
    files[indexed.file_path] = indexed;
    chunksIndexed += indexed.chunks.length;
    symbolsIndexed += indexed.symbols.length;
    bytesIndexed += indexed.size_bytes;
  }

  const index: SourceIndex = {
    version: INDEX_VERSION,
    created_at: now,
    updated_at: now,
    max_file_bytes: maxFileBytes,
    stats: {
      files_indexed: Object.keys(files).length,
      files_skipped: skippedCount,
      chunks_indexed: chunksIndexed,
      symbols_indexed: symbolsIndexed,
      bytes_indexed: bytesIndexed,
    },
    search: buildSearchIndex(Object.values(files).flatMap((file) => file.chunks)),
    files,
  };

  await saveSourceIndex(repoRoot, index);
  return index;
}

export async function clearSourceIndex(repoRoot: string): Promise<boolean> {
  const dir = path.dirname(sourceIndexPath(repoRoot));
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function getSourceIndexStatus(
  repoRoot: string,
): Promise<SourceIndexStatus> {
  const indexPath = sourceIndexPath(repoRoot);
  let index: SourceIndex | null;
  try {
    index = await loadSourceIndex(repoRoot);
  } catch (err) {
    return {
      indexed: false,
      index_path: indexPath,
      files_indexed: 0,
      chunks_indexed: 0,
      symbols_indexed: 0,
      stale_files: 0,
      missing_files: 0,
      new_files: 0,
      search_indexed: false,
      search_index_stale: false,
      fresh: false,
      error: { code: "INDEX_INVALID", message: String(err) },
    };
  }

  if (!index) {
    return {
      indexed: false,
      index_path: indexPath,
      files_indexed: 0,
      chunks_indexed: 0,
      symbols_indexed: 0,
      stale_files: 0,
      missing_files: 0,
      new_files: 0,
      search_indexed: false,
      search_index_stale: false,
      fresh: false,
    };
  }

  return (await loadedSourceIndexStatus(repoRoot, index, indexPath)).status;
}

async function loadedSourceIndexStatus(
  repoRoot: string,
  index: SourceIndex,
  indexPath: string,
): Promise<LoadedSourceIndexStatus> {
  const { candidates: currentFiles } = await findCandidateFiles(repoRoot, {
    maxFileBytes: index.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES,
  });
  const currentByPath = new Map(
    currentFiles.map((file) => [file.file_path, file] as const),
  );
  const searchReadyInput = searchReadyInputForIndex(index);
  const searchIndexed = Boolean(index.search);
  const searchIndexStale = !searchReadyInput.compatibleSearch;
  let staleFiles = 0;
  let missingFiles = 0;
  let newFiles = 0;

  for (const [filePath, indexedFile] of Object.entries(index.files)) {
    const current = currentByPath.get(filePath);
    if (!current) {
      missingFiles += 1;
      continue;
    }
    if (indexedFile.size_bytes !== current.size_bytes) {
      staleFiles += 1;
      continue;
    }
    if (
      typeof indexedFile.mtime_ms === "number" &&
      indexedFile.mtime_ms === current.mtime_ms
    ) {
      continue;
    }
    const content = await fs.readFile(current.absolute_path);
    const currentHash = hashBuffer(content);
    if (currentHash !== indexedFile.content_hash) {
      staleFiles += 1;
    }
  }

  for (const filePath of currentByPath.keys()) {
    if (!index.files[filePath]) {
      newFiles += 1;
    }
  }

  return {
    status: {
      indexed: true,
      index_path: indexPath,
      updated_at: index.updated_at,
      files_indexed: index.stats.files_indexed,
      chunks_indexed: index.stats.chunks_indexed,
      symbols_indexed: index.stats.symbols_indexed,
      stale_files: staleFiles,
      missing_files: missingFiles,
      new_files: newFiles,
      search_indexed: searchIndexed,
      search_index_stale: searchIndexStale,
      fresh:
        staleFiles === 0 &&
        missingFiles === 0 &&
        newFiles === 0 &&
        !searchIndexStale,
    },
    searchReadyInput,
  };
}

export async function searchSourceIndex(
  repoRoot: string,
  query: string,
  options: SourceSearchOptions = {},
): Promise<SourceSearchResponse> {
  const startedAt = Date.now();
  const trimmedQuery = query.trim();
  const limit = options.limit ?? 5;
  const maxContentChars = options.maxContentChars ?? 2400;
  const dependencyLimit = options.dependencyLimit ?? 0;
  const dependencyContentChars = options.dependencyContentChars ?? 600;
  const includeImpact = options.includeImpact ?? false;
  const impactLimit = options.impactLimit ?? 5;
  const impactContentChars = options.impactContentChars ?? 600;

  if (!trimmedQuery) {
    return {
      ok: false,
      query,
      search_time_ms: Date.now() - startedAt,
      total_results: 0,
      results: [],
      error: { code: "EMPTY_QUERY", message: "query must not be empty" },
    };
  }

  let index: SourceIndex | null = options.sourceIndex ?? null;
  try {
    index ??= await loadSourceIndex(repoRoot);
  } catch (err) {
    return {
      ok: false,
      query,
      search_time_ms: Date.now() - startedAt,
      total_results: 0,
      results: [],
      error: { code: "INDEX_INVALID", message: String(err) },
    };
  }

  if (!index) {
    return {
      ok: false,
      query,
      search_time_ms: Date.now() - startedAt,
      total_results: 0,
      results: [],
      error: {
        code: "INDEX_MISSING",
        message: "Run codemap scan or the index_codebase tool first.",
      },
    };
  }

  const warnings: string[] = [];
  const { status, searchReadyInput } = await loadedSourceIndexStatus(
    repoRoot,
    index,
    sourceIndexPath(repoRoot),
  );
  if (
    status.indexed &&
    (status.stale_files > 0 ||
      status.missing_files > 0 ||
      status.new_files > 0)
  ) {
    warnings.push(
      "Source index is stale; refresh with codemap scan or index_codebase before relying on source hits.",
    );
  }
  if (status.search_index_stale) {
    warnings.push(
      "Source index search snapshot is stale or missing; refresh with codemap scan or index_codebase for faster repeated searches.",
    );
  }

  const searchReady = getSearchReadySnapshot(repoRoot, index, searchReadyInput);
  const relatedNodesByFile = await loadRelatedNodesByFile(repoRoot);
  const queryTokens = searchQueryTokens(trimmedQuery);
  const needsRelationshipRanking = isImpactReviewQuery(queryTokens);
  const importRelationships = buildImportRelationshipIndex(index);
  const allRanked = rankChunks(
    trimmedQuery,
    searchReady,
    relatedNodesByFile,
    {
      queryTokens,
      reverseImportIndex: importRelationships.reverseImportIndex,
      localImportingFiles: importRelationships.localImportingFiles,
      needsRelationshipRanking,
    },
  );
  const filteredRanked = filterWeakRankedChunks(allRanked);
  const expandedRanked = expandRankedWithCompanionChunks(filteredRanked, {
    index,
    limit,
    queryTokens,
    relatedNodesByFile,
    reverseImportIndex: importRelationships.reverseImportIndex,
  });
  const ranked = diversifyRankedChunks(expandedRanked, limit)
    .map(({ chunk, score, score_breakdown, match_reasons, related_nodes }) => ({
      file_path: chunk.file_path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      language: chunk.language,
      chunk_type: chunk.chunk_type,
      score: Number(score.toFixed(4)),
      score_breakdown: roundScoreBreakdown(score_breakdown),
      match_reasons: roundMatchReasons(match_reasons),
      content:
        chunk.content.length > maxContentChars
          ? `${chunk.content.slice(0, maxContentChars)}\n// ... truncated`
          : chunk.content,
      symbols: chunk.symbols,
      imports: chunk.imports,
      exports: chunk.exports,
      related_nodes,
      dependency_context: buildDependencyContext(
        index,
        chunk.file_path,
        dependencyLimit,
        dependencyContentChars,
        importRelationships.reverseImportIndex,
      ),
      impact_context: includeImpact
        ? buildImpactContext(
            index,
            chunk,
            trimmedQuery,
            impactLimit,
            impactContentChars,
            importRelationships.reverseImportIndex,
          )
        : undefined,
    }));

  return {
    ok: true,
    query,
    index_updated_at: index.updated_at,
    search_time_ms: Date.now() - startedAt,
    total_results: countUniqueRankedChunks(expandedRanked),
    results: ranked,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

async function saveSourceIndex(
  repoRoot: string,
  index: SourceIndex,
): Promise<void> {
  const indexPath = sourceIndexPath(repoRoot);
  await ensureSeedFile(indexPath, {
    version: INDEX_VERSION,
    created_at: index.created_at,
    updated_at: index.updated_at,
    max_file_bytes: index.max_file_bytes,
    stats: {
      files_indexed: 0,
      files_skipped: 0,
      chunks_indexed: 0,
      symbols_indexed: 0,
      bytes_indexed: 0,
    },
    search: buildSearchIndex([]),
    files: {},
  });

  const release = await lock(indexPath, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    const tmp = `${indexPath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(sortKeysDeep(index), null, 2)}\n`);
    await fs.rename(tmp, indexPath);
  } finally {
    await release();
  }
}

async function findCandidateFiles(
  repoRoot: string,
  options: ScanSourceIndexOptions = {},
): Promise<CandidateFileSearchResult> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const candidates: CandidateFile[] = [];
  let skippedCount = 0;

  async function visit(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(repoRoot, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDir
        ? path.join(relativeDir, entry.name)
        : entry.name;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skippedCount += 1;
          continue;
        }
        await visit(relativePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (isGeneratedPath(relativePath)) {
        skippedCount += 1;
        continue;
      }
      const normalizedRelativePath = normalizePath(relativePath);
      const language = languageForPath(normalizedRelativePath);
      if (!language) {
        skippedCount += 1;
        continue;
      }

      const absolutePath = path.join(repoRoot, relativePath);
      const stat = await fs.stat(absolutePath);
      if (stat.size > maxFileBytes) {
        skippedCount += 1;
        continue;
      }
      candidates.push({
        file_path: normalizedRelativePath,
        absolute_path: absolutePath,
        language,
        size_bytes: stat.size,
        mtime_ms: Math.round(stat.mtimeMs),
      });
    }
  }

  await visit("");
  return { candidates, skippedCount };
}

function languageForPath(filePath: string): string | null {
  const normalized = normalizePath(filePath).toLowerCase();
  const basename = path.posix.basename(normalized);
  return (
    SUPPORTED_FILENAMES.get(basename) ??
    SUPPORTED_EXTENSIONS.get(path.posix.extname(basename)) ??
    null
  );
}

function indexFile(
  candidate: CandidateFile,
  content: string,
  indexedAt: string,
): IndexedSourceFile {
  const lines = content.split(/\r?\n/);
  const contentHash = hashString(content);
  const facts = extractSourceFacts(candidate, content, lines);
  const chunks = createChunks(
    candidate,
    lines,
    contentHash,
    facts.symbols,
    facts.imports,
    facts.exports,
  );

  return {
    file_path: candidate.file_path,
    language: candidate.language,
    size_bytes: candidate.size_bytes,
    mtime_ms: candidate.mtime_ms,
    line_count: lines.length,
    content_hash: contentHash,
    indexed_at: indexedAt,
    imports: facts.imports,
    exports: facts.exports,
    symbols: facts.symbols,
    references: facts.references,
    references_truncated: facts.references_truncated,
    chunks,
  };
}

function extractSourceFacts(
  candidate: CandidateFile,
  content: string,
  lines: string[],
): ExtractedSourceFacts {
  return (
    extractAstSourceFacts(candidate, content) ??
    extractFallbackSourceFacts(candidate.language, lines)
  );
}

function extractFallbackSourceFacts(
  language: string,
  lines: string[],
): ExtractedSourceFacts {
  const symbols = extractSymbols(language, lines);
  return {
    imports: extractImports(language, lines),
    exports: extractFallbackExports(language, lines, symbols),
    symbols,
    references: [],
    references_truncated: false,
  };
}

function extractFallbackExports(
  language: string,
  lines: string[],
  symbols: SourceSymbol[],
): string[] {
  if (
    language === "typescript" ||
    language === "javascript" ||
    language === "markdown"
  ) {
    return extractExports(lines);
  }
  return symbols
    .filter((symbol) => symbol.exported)
    .map((symbol) => symbol.name)
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();
}

function extractAstSourceFacts(
  candidate: CandidateFile,
  content: string,
): ExtractedSourceFacts | null {
  if (candidate.language !== "typescript" && candidate.language !== "javascript") {
    return null;
  }

  try {
    if (hasSyntacticErrors(candidate.file_path, content)) {
      return null;
    }
    const sourceFile = ts.createSourceFile(
      candidate.file_path,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(candidate.file_path),
    );

    const namedExportLocals = collectNamedExportLocals(sourceFile);
    const imports: SourceImport[] = [];
    const exports = new Set<string>();
    const symbols: SourceSymbol[] = [];

    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        isStringLiteralLike(statement.moduleSpecifier)
      ) {
        imports.push(
          sourceImportFromNode(
            sourceFile,
            statement.moduleSpecifier,
            statement,
          ),
        );
        continue;
      }

      if (ts.isExportDeclaration(statement)) {
        if (
          statement.moduleSpecifier &&
          isStringLiteralLike(statement.moduleSpecifier)
        ) {
          imports.push(
            sourceImportFromNode(
              sourceFile,
              statement.moduleSpecifier,
              statement,
            ),
          );
        }
        if (statement.exportClause) {
          if (ts.isNamedExports(statement.exportClause)) {
            for (const specifier of statement.exportClause.elements) {
              exports.add(specifier.name.text);
            }
          } else {
            exports.add(statement.exportClause.name.text);
          }
        }
        continue;
      }

      if (ts.isExportAssignment(statement)) {
        exports.add("default");
        continue;
      }

      if (isDefaultExport(statement)) {
        exports.add("default");
      }

      for (const symbol of symbolsForStatement(
        sourceFile,
        statement,
        namedExportLocals,
      )) {
        symbols.push(symbol);
        if (isDirectNamedExport(statement)) exports.add(symbol.name);
        if (isDefaultExport(statement)) exports.add("default");
      }
    }

    findRuntimeImports(sourceFile, imports);
    const extractedReferences = extractReferences(
      sourceFile,
      MAX_REFERENCES_PER_FILE,
    );

    return {
      imports: sortImports(dedupeImports(imports)),
      exports: Array.from(exports).sort(),
      symbols: sortSymbols(dedupeSymbols(symbols)),
      references: sortReferences(
        dedupeReferences(extractedReferences.references),
      ),
      references_truncated: extractedReferences.truncated,
    };
  } catch {
    return null;
  }
}

function hasSyntacticErrors(filePath: string, content: string): boolean {
  const result = ts.transpileModule(content, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      experimentalDecorators: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.Latest,
    },
  });
  return (result.diagnostics ?? []).some(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath)) {
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".cjs":
    case ".mjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function collectNamedExportLocals(sourceFile: ts.SourceFile): Set<string> {
  const locals = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const specifier of statement.exportClause.elements) {
      locals.add(specifier.propertyName?.text ?? specifier.name.text);
    }
  }
  return locals;
}

function sourceImportFromNode(
  sourceFile: ts.SourceFile,
  literal: ts.StringLiteralLike,
  locationNode: ts.Node = literal,
): SourceImport {
  const range = lineRange(sourceFile, locationNode);
  return { module: literal.text, line: range.line, end_line: range.end_line };
}

function symbolsForStatement(
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  namedExportLocals: Set<string>,
): SourceSymbol[] {
  if (ts.isVariableStatement(statement)) {
    const statementExported = hasSyntaxModifier(
      statement,
      ts.SyntaxKind.ExportKeyword,
    );
    return statement.declarationList.declarations
      .flatMap((declaration) => bindingIdentifiers(declaration.name))
      .map((binding) =>
        symbolFromNamedNode(
          sourceFile,
          statement,
          binding.name,
          "const",
          statementExported || namedExportLocals.has(binding.name),
          binding.node,
        ),
      );
  }

  if (
    ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    if (!statement.name) return [];
    const exported =
      hasSyntaxModifier(statement, ts.SyntaxKind.ExportKeyword) ||
      namedExportLocals.has(statement.name.text);
    return [
      symbolFromNamedNode(
        sourceFile,
        statement,
        statement.name.text,
        symbolKindForDeclaration(statement),
        exported,
        statement.name,
      ),
    ];
  }

  return [];
}

interface BindingIdentifier {
  name: string;
  node?: ts.Identifier;
}

function bindingIdentifiers(name: ts.BindingName): BindingIdentifier[] {
  if (ts.isIdentifier(name)) return [{ name: name.text, node: name }];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  );
}

function symbolFromNamedNode(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  name: string,
  kind: SourceSymbol["kind"],
  exported: boolean,
  nameNode?: ts.Node,
): SourceSymbol {
  const range = lineRange(sourceFile, node);
  const nameRange = nameNode ? lineRange(sourceFile, nameNode) : undefined;
  return {
    name,
    kind,
    line: range.line,
    name_line: nameRange?.line,
    end_line: range.end_line,
    exported,
  };
}

function symbolKindForDeclaration(
  declaration:
    | ts.ClassDeclaration
    | ts.EnumDeclaration
    | ts.FunctionDeclaration
    | ts.InterfaceDeclaration
    | ts.TypeAliasDeclaration,
): SourceSymbol["kind"] {
  if (ts.isClassDeclaration(declaration)) return "class";
  if (ts.isEnumDeclaration(declaration)) return "enum";
  if (ts.isFunctionDeclaration(declaration)) return "function";
  if (ts.isInterfaceDeclaration(declaration)) return "interface";
  return "type";
}

function isDefaultExport(node: ts.Node): boolean {
  return hasSyntaxModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function isDirectNamedExport(node: ts.Node): boolean {
  return (
    hasSyntaxModifier(node, ts.SyntaxKind.ExportKeyword) &&
    !isDefaultExport(node)
  );
}

function hasSyntaxModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

function findRuntimeImports(
  sourceFile: ts.SourceFile,
  imports: SourceImport[],
): void {
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      isStringLiteralLike(node.arguments[0]) &&
      (isRequireCall(node) || isDynamicImportCall(node))
    ) {
      imports.push(sourceImportFromNode(sourceFile, node.arguments[0], node));
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);
}

function isRequireCall(node: ts.CallExpression): boolean {
  return ts.isIdentifier(node.expression) && node.expression.text === "require";
}

function isDynamicImportCall(node: ts.CallExpression): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function extractReferences(
  sourceFile: ts.SourceFile,
  limit: number,
): { references: SourceReference[]; truncated: boolean } {
  const references: SourceReference[] = [];
  let truncated = false;

  function visit(node: ts.Node): void {
    if (truncated) return;
    if (ts.isIdentifier(node) && !isReferenceExcludedIdentifier(node)) {
      if (references.length >= limit) {
        truncated = true;
        return;
      }
      const range = lineRange(sourceFile, node);
      references.push({
        name: node.text,
        start_line: range.line,
        end_line: range.end_line,
      });
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return { references, truncated };
}

function isReferenceExcludedIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isBindingElement(parent) ||
      ts.isTypeParameterDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }

  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isEnumMember(parent) && parent.name === node)
  );
}

function isStringLiteralLike(node: ts.Node): node is ts.StringLiteralLike {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function lineRange(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { line: number; end_line: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return { line: start.line + 1, end_line: end.line + 1 };
}

function dedupeImports(imports: SourceImport[]): SourceImport[] {
  const byKey = new Map<string, SourceImport>();
  for (const sourceImport of imports) {
    byKey.set(`${sourceImport.module}:${sourceImport.line}`, sourceImport);
  }
  return Array.from(byKey.values());
}

function sortImports(imports: SourceImport[]): SourceImport[] {
  return imports.sort(
    (a, b) => a.line - b.line || a.module.localeCompare(b.module),
  );
}

function dedupeSymbols(symbols: SourceSymbol[]): SourceSymbol[] {
  const byKey = new Map<string, SourceSymbol>();
  for (const symbol of symbols) {
    byKey.set(`${symbol.name}:${symbol.kind}:${symbol.line}`, symbol);
  }
  return Array.from(byKey.values());
}

function sortSymbols(symbols: SourceSymbol[]): SourceSymbol[] {
  return symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function dedupeReferences(references: SourceReference[]): SourceReference[] {
  const byKey = new Map<string, SourceReference>();
  for (const reference of references) {
    byKey.set(
      `${reference.name}:${reference.start_line}:${reference.end_line}`,
      reference,
    );
  }
  return Array.from(byKey.values());
}

function sortReferences(references: SourceReference[]): SourceReference[] {
  return references.sort(
    (a, b) =>
      a.start_line - b.start_line ||
      a.end_line - b.end_line ||
      a.name.localeCompare(b.name),
  );
}

function extractImports(language: string, lines: string[]): SourceImport[] {
  switch (language) {
    case "c":
    case "cpp":
      return extractCStyleIncludes(lines);
    case "java":
    case "kotlin":
    case "csharp":
      return extractDottedImports(lines);
    case "go":
      return extractGoImports(lines);
    case "rust":
      return extractRustImports(lines);
    case "python":
      return extractPythonImports(lines);
    default:
      return extractTsLikeImports(lines);
  }
}

function extractTsLikeImports(lines: string[]): SourceImport[] {
  const imports: SourceImport[] = [];
  const importPattern =
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/;
  const exportFromPattern = /\bexport\s+[^'"]+\s+from\s+["']([^"']+)["']/;
  const requirePattern = /\brequire\(["']([^"']+)["']\)/;

  lines.forEach((line, index) => {
    const match =
      line.match(importPattern) ??
      line.match(exportFromPattern) ??
      line.match(requirePattern);
    if (match?.[1]) {
      imports.push({ module: match[1], line: index + 1, end_line: index + 1 });
    }
  });

  return imports;
}

function extractCStyleIncludes(lines: string[]): SourceImport[] {
  const imports: SourceImport[] = [];
  // Angle/system includes are intentionally ignored to avoid noisy external edges.
  const includePattern = /^\s*#\s*include\s+"([^"]+)"/;

  lines.forEach((line, index) => {
    const match = line.match(includePattern);
    if (!match?.[1]) return;
    const module = match[1].startsWith(".") ? match[1] : `./${match[1]}`;
    imports.push({ module, line: index + 1, end_line: index + 1 });
  });

  return imports;
}

function extractDottedImports(lines: string[]): SourceImport[] {
  const imports: SourceImport[] = [];
  const importPattern =
    /^\s*import\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\.\*)?)(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*;?/;
  const usingPattern =
    /^\s*using\s+(?:static\s+)?(?:[A-Za-z_$][\w$]*\s*=\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/;

  lines.forEach((line, index) => {
    const match = line.match(importPattern) ?? line.match(usingPattern);
    if (match?.[1]) {
      imports.push({ module: match[1], line: index + 1, end_line: index + 1 });
    }
  });

  return imports;
}

function extractGoImports(lines: string[]): SourceImport[] {
  const imports: SourceImport[] = [];
  let inBlock = false;

  lines.forEach((line, index) => {
    if (/^\s*import\s*\(\s*$/.test(line)) {
      inBlock = true;
      return;
    }
    if (inBlock && /^\s*\)\s*$/.test(line)) {
      inBlock = false;
      return;
    }
    const match = inBlock
      ? line.match(/^\s*(?:[_A-Za-z.][\w.]*\s+)?["']([^"']+)["']/)
      : line.match(/^\s*import\s+(?:[_A-Za-z.][\w.]*\s+)?["']([^"']+)["']/);
    if (match?.[1]) {
      imports.push({ module: match[1], line: index + 1, end_line: index + 1 });
    }
  });

  return imports;
}

function extractRustImports(lines: string[]): SourceImport[] {
  const imports: SourceImport[] = [];
  const modPattern = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/;
  const usePattern = /^\s*use\s+([^;]+);/;

  lines.forEach((line, index) => {
    const modMatch = line.match(modPattern);
    if (modMatch?.[1]) {
      imports.push({
        module: `./${modMatch[1]}`,
        line: index + 1,
        end_line: index + 1,
      });
      return;
    }
    const useMatch = line.match(usePattern);
    if (useMatch?.[1]) {
      imports.push({
        module: useMatch[1].trim(),
        line: index + 1,
        end_line: index + 1,
      });
    }
  });

  return imports;
}

function extractPythonImports(lines: string[]): SourceImport[] {
  const imports: SourceImport[] = [];
  const fromRelativePattern =
    /^\s*from\s+(\.+)([A-Za-z_][\w.]*)?\s+import\s+(.+)/;
  const fromPattern = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/;
  const importPattern = /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+\w+)?/;

  lines.forEach((line, index) => {
    const relative = line.match(fromRelativePattern);
    if (relative?.[1]) {
      if (!relative[2]) {
        for (const target of pythonImportTargets(relative[3] ?? "")) {
          imports.push({
            module: pythonRelativeModule(relative[1], target),
            line: index + 1,
            end_line: index + 1,
          });
        }
        return;
      }
      imports.push({
        module: pythonRelativeModule(relative[1], relative[2]),
        line: index + 1,
        end_line: index + 1,
      });
      return;
    }
    const match = line.match(fromPattern) ?? line.match(importPattern);
    if (match?.[1]) {
      imports.push({ module: match[1], line: index + 1, end_line: index + 1 });
    }
  });

  return imports;
}

function pythonImportTargets(targets: string): string[] {
  return targets
    .replace(/[()]/g, "")
    .split(",")
    .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim())
    .filter(
      (target): target is string =>
        Boolean(target) && /^[A-Za-z_]\w*$/.test(target),
    );
}

function pythonRelativeModule(dots: string, moduleName: string): string {
  const relativePrefix =
    dots.length === 1 ? "./" : "../".repeat(Math.max(1, dots.length - 1));
  return `${relativePrefix}${moduleName.replaceAll(".", "/")}`;
}

function extractExports(lines: string[]): string[] {
  const exports = new Set<string>();
  const directPattern =
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
  const namedPattern = /^\s*export\s*\{([^}]+)\}/;

  for (const line of lines) {
    const direct = line.match(directPattern);
    if (direct?.[1]) {
      exports.add(direct[1]);
    }
    const named = line.match(namedPattern);
    if (named?.[1]) {
      for (const part of named[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) exports.add(name);
      }
    }
  }

  return Array.from(exports).sort();
}

function extractSymbols(language: string, lines: string[]): SourceSymbol[] {
  switch (language) {
    case "c":
    case "cpp":
      return extractCStyleSymbols(lines);
    case "java":
    case "kotlin":
    case "csharp":
      return extractDottedLanguageSymbols(lines);
    case "go":
      return extractGoSymbols(lines);
    case "rust":
      return extractRustSymbols(lines);
    case "python":
      return extractPythonSymbols(lines);
    default:
      return extractTsLikeSymbols(lines);
  }
}

function extractTsLikeSymbols(lines: string[]): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  const patterns: Array<{
    kind: SourceSymbol["kind"];
    pattern: RegExp;
    exportedPattern?: RegExp;
  }> = [
    {
      kind: "class",
      pattern:
        /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: "function",
      pattern:
        /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: "interface",
      pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: "type",
      pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: "enum",
      pattern: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: "const",
      pattern:
        /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>/,
    },
  ];

  lines.forEach((line, index) => {
    for (const { kind, pattern } of patterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        symbols.push({
          name: match[1],
          kind,
          line: index + 1,
          end_line: index + 1,
          exported: /\bexport\b/.test(line),
        });
        break;
      }
    }
  });

  return symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function extractCStyleSymbols(lines: string[]): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  const typePattern =
    /^\s*(?:typedef\s+)?(struct|union|class)\s+([A-Za-z_]\w*)\b\s*(?:[{:;]|$)/;
  const enumPattern = /^\s*(?:typedef\s+)?enum\s+([A-Za-z_]\w*)?\s*\{/;
  const definePattern = /^\s*#\s*define\s+([A-Z_][A-Z0-9_]*)\b/;
  const functionPattern =
    /^\s*(?!if\b|for\b|while\b|switch\b|return\b)(?:[A-Za-z_][\w:<>]*\s+)+(?:\*+\s*)?([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|;)/;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const typeMatch = line.match(typePattern);
    if (typeMatch?.[2]) {
      symbols.push({
        name: typeMatch[2],
        kind: "type",
        line: lineNumber,
        end_line: lineNumber,
        exported: !/^\s*static\b/.test(line),
      });
      return;
    }
    const enumMatch = line.match(enumPattern);
    if (enumMatch?.[1]) {
      symbols.push({
        name: enumMatch[1],
        kind: "enum",
        line: lineNumber,
        end_line: lineNumber,
        exported: !/^\s*static\b/.test(line),
      });
      return;
    }
    const defineMatch = line.match(definePattern);
    if (defineMatch?.[1]) {
      symbols.push({
        name: defineMatch[1],
        kind: "const",
        line: lineNumber,
        end_line: lineNumber,
        exported: true,
      });
      return;
    }
    const functionMatch = line.match(functionPattern);
    if (functionMatch?.[1]) {
      symbols.push({
        name: functionMatch[1],
        kind: "function",
        line: lineNumber,
        end_line: lineNumber,
        exported: !/^\s*static\b/.test(line),
      });
    }
  });

  return sortFallbackSymbols(symbols);
}

function extractDottedLanguageSymbols(lines: string[]): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  const typePattern =
    /^\s*(?:(?:public|private|protected|internal|static|final|sealed|abstract|partial|open|data|value)\s+)*(class|interface|enum|record|object)\s+([A-Za-z_$][\w$]*)/;
  const kotlinFunctionPattern =
    /^\s*(?:(?:public|private|protected|internal|open|override|suspend)\s+)*fun\s+([A-Za-z_$][\w$]*)\s*\(/;
  const methodPattern =
    /^\s*(?:(?:public|private|protected|internal|static|final|override|virtual|async|synchronized)\s+)+[A-Za-z_$][\w$<>,.?[\]\s]*\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:\{|=>|throws\b)/;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const typeMatch = line.match(typePattern);
    if (typeMatch?.[1] && typeMatch[2]) {
      const kind =
        typeMatch[1] === "interface"
          ? "interface"
          : typeMatch[1] === "enum"
            ? "enum"
            : typeMatch[1] === "record"
              ? "type"
              : "class";
      symbols.push({
        name: typeMatch[2],
        kind,
        line: lineNumber,
        end_line: lineNumber,
        exported: /\b(public|open)\b/.test(line),
      });
      return;
    }
    const functionMatch =
      line.match(kotlinFunctionPattern) ?? line.match(methodPattern);
    if (functionMatch?.[1]) {
      symbols.push({
        name: functionMatch[1],
        kind: "function",
        line: lineNumber,
        end_line: lineNumber,
        exported: /\b(public|open)\b/.test(line),
      });
    }
  });

  return sortFallbackSymbols(symbols);
}

function extractGoSymbols(lines: string[]): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  const functionPattern = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/;
  const typePattern = /^\s*type\s+([A-Za-z_]\w*)\s+\w+/;
  const valuePattern = /^\s*(?:const|var)\s+([A-Za-z_]\w*)\b/;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const functionMatch = line.match(functionPattern);
    if (functionMatch?.[1]) {
      symbols.push({
        name: functionMatch[1],
        kind: "function",
        line: lineNumber,
        end_line: lineNumber,
        exported: /^[A-Z]/.test(functionMatch[1]),
      });
      return;
    }
    const typeMatch = line.match(typePattern);
    if (typeMatch?.[1]) {
      symbols.push({
        name: typeMatch[1],
        kind: "type",
        line: lineNumber,
        end_line: lineNumber,
        exported: /^[A-Z]/.test(typeMatch[1]),
      });
      return;
    }
    const valueMatch = line.match(valuePattern);
    if (valueMatch?.[1]) {
      symbols.push({
        name: valueMatch[1],
        kind: "const",
        line: lineNumber,
        end_line: lineNumber,
        exported: /^[A-Z]/.test(valueMatch[1]),
      });
    }
  });

  return sortFallbackSymbols(symbols);
}

function extractRustSymbols(lines: string[]): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  const functionPattern =
    /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/;
  const typePattern =
    /^\s*(pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/;
  const valuePattern =
    /^\s*(pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)\b/;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const functionMatch = line.match(functionPattern);
    if (functionMatch?.[2]) {
      symbols.push({
        name: functionMatch[2],
        kind: "function",
        line: lineNumber,
        end_line: lineNumber,
        exported: Boolean(functionMatch[1]),
      });
      return;
    }
    const typeMatch = line.match(typePattern);
    if (typeMatch?.[2] && typeMatch[3]) {
      symbols.push({
        name: typeMatch[3],
        kind: typeMatch[2] === "enum" ? "enum" : "type",
        line: lineNumber,
        end_line: lineNumber,
        exported: Boolean(typeMatch[1]),
      });
      return;
    }
    const valueMatch = line.match(valuePattern);
    if (valueMatch?.[2]) {
      symbols.push({
        name: valueMatch[2],
        kind: "const",
        line: lineNumber,
        end_line: lineNumber,
        exported: Boolean(valueMatch[1]),
      });
    }
  });

  return sortFallbackSymbols(symbols);
}

function extractPythonSymbols(lines: string[]): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  const classPattern = /^\s*class\s+([A-Za-z_]\w*)\b/;
  const functionPattern = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
  const constPattern = /^\s*([A-Z][A-Z0-9_]*)\s*=/;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const classMatch = line.match(classPattern);
    if (classMatch?.[1]) {
      symbols.push({
        name: classMatch[1],
        kind: "class",
        line: lineNumber,
        end_line: lineNumber,
        exported: !classMatch[1].startsWith("_"),
      });
      return;
    }
    const functionMatch = line.match(functionPattern);
    if (functionMatch?.[1]) {
      symbols.push({
        name: functionMatch[1],
        kind: "function",
        line: lineNumber,
        end_line: lineNumber,
        exported: !functionMatch[1].startsWith("_"),
      });
      return;
    }
    const constMatch = line.match(constPattern);
    if (constMatch?.[1]) {
      symbols.push({
        name: constMatch[1],
        kind: "const",
        line: lineNumber,
        end_line: lineNumber,
        exported: !constMatch[1].startsWith("_"),
      });
    }
  });

  return sortFallbackSymbols(symbols);
}

function sortFallbackSymbols(symbols: SourceSymbol[]): SourceSymbol[] {
  return symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function createChunks(
  candidate: CandidateFile,
  lines: string[],
  contentHash: string,
  symbols: SourceSymbol[],
  imports: SourceImport[],
  exports: string[],
): SourceChunk[] {
  if (symbols.length === 0) {
    return [
      buildChunk(
        candidate,
        lines,
        1,
        Math.max(1, lines.length),
        "file",
        [],
        imports,
        exports,
        contentHash,
      ),
    ];
  }

  const chunks: SourceChunk[] = [];
  const firstSymbol = symbols[0];
  if (firstSymbol && firstSymbol.line > 1) {
    const preambleEndLine = firstSymbol.line - 1;
    const preamble = lines.slice(0, preambleEndLine).join("\n");
    if (preamble.trim().length > 0) {
      chunks.push(
        buildChunk(
          candidate,
          lines,
          1,
          preambleEndLine,
          "mixed",
          [],
          imports,
          exports,
          contentHash,
        ),
      );
    }
  }

  for (const [index, symbol] of symbols.entries()) {
    const next = symbols[index + 1];
    const startLine = symbol.line;
    const endLine = next ? Math.max(symbol.line, next.line - 1) : lines.length;
    chunks.push(
      buildChunk(
        candidate,
        lines,
        startLine,
        endLine,
        symbol.kind,
        [symbol],
        imports,
        exports,
        contentHash,
      ),
    );
  }

  return chunks;
}

function buildChunk(
  candidate: CandidateFile,
  lines: string[],
  startLine: number,
  endLine: number,
  chunkType: SourceChunk["chunk_type"],
  symbols: SourceSymbol[],
  imports: SourceImport[],
  exports: string[],
  contentHash: string,
): SourceChunk {
  const content = lines.slice(startLine - 1, endLine).join("\n").trimEnd();
  return {
    id: `${candidate.file_path}:${startLine}-${endLine}`,
    file_path: candidate.file_path,
    language: candidate.language,
    start_line: startLine,
    end_line: endLine,
    chunk_type: chunkType,
    symbols,
    imports,
    exports,
    content,
    content_hash: contentHash,
  };
}

function sourceChunks(index: SourceIndex): SourceChunk[] {
  return Object.values(index.files)
    .sort((a, b) => a.file_path.localeCompare(b.file_path))
    .flatMap((file) =>
      file.chunks
        .slice()
        .sort(
          (a, b) =>
            a.start_line - b.start_line ||
            a.end_line - b.end_line ||
            a.id.localeCompare(b.id),
        ),
    );
}

function buildSearchIndex(chunks: SourceChunk[]): SourceSearchIndex {
  const documents: Record<string, SourceSearchDocumentStats> = {};
  const documentFrequencies = new Map<string, number>();
  const postingsByToken = new Map<string, SourceSearchPosting[]>();
  let totalLength = 0;

  for (const chunk of chunks) {
    const termFrequencies = new Map<string, number>();
    for (const token of tokenize(chunkDocument(chunk))) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }

    const length = Array.from(termFrequencies.values()).reduce(
      (sum, frequency) => sum + frequency,
      0,
    );
    totalLength += length;
    documents[chunk.id] = {
      chunk_id: chunk.id,
      content_hash: chunk.content_hash,
      length,
    };

    for (const [token, termFrequency] of Array.from(
      termFrequencies.entries(),
    ).sort(([a], [b]) => a.localeCompare(b))) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
      const postings = postingsByToken.get(token) ?? [];
      postings.push({
        chunk_id: chunk.id,
        term_frequency: termFrequency,
      });
      postingsByToken.set(token, postings);
    }
  }

  return {
    version: SEARCH_INDEX_VERSION,
    document_count: chunks.length,
    average_document_length: totalLength / Math.max(1, chunks.length),
    document_frequencies: Object.fromEntries(
      Array.from(documentFrequencies.entries()).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
    documents: Object.fromEntries(
      Object.entries(documents).sort(([a], [b]) => a.localeCompare(b)),
    ),
    postings: Object.fromEntries(
      Array.from(postingsByToken.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([token, postings]) => [
          token,
          postings.sort((a, b) => a.chunk_id.localeCompare(b.chunk_id)),
        ]),
    ),
  };
}

function isSearchIndexCompatible(
  index: SourceIndex,
  chunks: SourceChunk[],
): boolean {
  const search = index.search;
  if (!search || search.version !== SEARCH_INDEX_VERSION) return false;
  if (search.document_count !== chunks.length) return false;
  if (!search.documents || !search.document_frequencies || !search.postings) {
    return false;
  }

  const documentIds = Object.keys(search.documents);
  if (documentIds.length !== chunks.length) return false;

  for (const chunk of chunks) {
    const document = search.documents[chunk.id];
    if (!document) return false;
    if (document.chunk_id !== chunk.id) return false;
    if (document.content_hash !== chunk.content_hash) return false;
    if (!Number.isFinite(document.length) || document.length < 0) return false;
  }

  return true;
}

function searchReadyInputForIndex(index: SourceIndex): SearchReadyInput {
  const chunks = sourceChunks(index);
  const compatibleSearch =
    index.search && isSearchIndexCompatible(index, chunks)
      ? index.search
      : undefined;
  return { chunks, compatibleSearch };
}

function getSearchReadySnapshot(
  repoRoot: string,
  index: SourceIndex,
  input = searchReadyInputForIndex(index),
): SearchReadySnapshot {
  const { chunks, compatibleSearch } = input;
  const cacheKey = searchReadyCacheKey(repoRoot, index, chunks);
  const cached = searchReadyCache.get(cacheKey);
  if (cached) return cached;

  const search = compatibleSearch ?? buildSearchIndex(chunks);
  const snapshot: SearchReadySnapshot = {
    chunks,
    document_frequencies: new Map(
      Object.entries(search.document_frequencies ?? {}),
    ),
    documents: new Map(Object.entries(search.documents ?? {})),
    document_count: search.document_count,
    average_document_length: search.average_document_length,
    postings: new Map(Object.entries(search.postings ?? {})),
  };

  searchReadyCache.set(cacheKey, snapshot);
  while (searchReadyCache.size > SEARCH_READY_CACHE_LIMIT) {
    const oldestKey = searchReadyCache.keys().next().value;
    if (!oldestKey) break;
    searchReadyCache.delete(oldestKey);
  }

  return snapshot;
}

function searchReadyCacheKey(
  repoRoot: string,
  index: SourceIndex,
  chunks: SourceChunk[],
): string {
  const signature = createHash("sha256")
    .update(
      chunks
        .map((chunk) => `${chunk.id}:${chunk.content_hash}:${chunk.start_line}`)
        .join("\n"),
    )
    .digest("hex");
  return [
    path.resolve(repoRoot),
    index.updated_at,
    index.stats.chunks_indexed,
    index.stats.bytes_indexed,
    signature,
  ].join("|");
}

function rankChunks(
  query: string,
  searchReady: SearchReadySnapshot,
  relatedNodesByFile: Map<
    string,
    Array<Pick<Node, "id" | "kind" | "name" | "summary">>
  >,
  options: {
    queryTokens?: string[];
    reverseImportIndex?: ReverseImportIndex;
    localImportingFiles?: Set<string>;
    needsRelationshipRanking?: boolean;
  } = {},
): RankedChunk[] {
  const queryTokens = options.queryTokens ?? searchQueryTokens(query);
  const reverseImportIndex = options.reverseImportIndex ?? new Map();
  const localImportingFiles = options.localImportingFiles ?? new Set();
  const needsRelationshipRanking =
    options.needsRelationshipRanking ?? isImpactReviewQuery(queryTokens);
  const bm25Scores = bm25ScoresForQuery(queryTokens, searchReady);

  return searchReady.chunks
    .map((chunk) => {
      const relatedNodes = relatedNodesByFile.get(chunk.file_path) ?? [];
      const bm25Score = bm25Scores.get(chunk.id) ?? 0;
      const fieldScore = scoreSourceFields(
        query,
        queryTokens,
        chunk,
        relatedNodes,
        bm25Score,
      );
      const baseScore =
        fieldScore.score_breakdown.bm25 +
        fieldScore.score_breakdown.content +
        fieldScore.score_breakdown.export +
        fieldScore.score_breakdown.import +
        fieldScore.score_breakdown.path +
        fieldScore.score_breakdown.related_graph_node +
        fieldScore.score_breakdown.symbol;
      const score = adjustSourceScore(baseScore, {
        chunk,
        queryTokens,
        score_breakdown: fieldScore.score_breakdown,
        reverseImportIndex,
        localImportingFiles,
        needsRelationshipRanking,
      });
      return {
        chunk,
        score,
        score_breakdown: fieldScore.score_breakdown,
        match_reasons: fieldScore.match_reasons,
        related_nodes: relatedNodes.slice(0, 3),
      };
    })
    .filter((result) => result.score > 0)
    .sort(compareRankedChunks);
}

function compareRankedChunks(a: RankedChunk, b: RankedChunk): number {
  return (
    b.score - a.score ||
    a.chunk.file_path.localeCompare(b.chunk.file_path) ||
    a.chunk.start_line - b.chunk.start_line
  );
}

function bm25ScoresForQuery(
  queryTokens: string[],
  searchReady: SearchReadySnapshot,
): Map<string, number> {
  const k1 = 1.2;
  const b = 0.75;
  const scores = new Map<string, number>();

  for (const token of new Set(queryTokens)) {
    const postings = searchReady.postings.get(token);
    if (!postings || postings.length === 0) continue;
    const documentFrequency =
      searchReady.document_frequencies.get(token) ?? postings.length;
    const idf = Math.log(
      1 +
        (searchReady.document_count - documentFrequency + 0.5) /
          (documentFrequency + 0.5),
    );
    for (const posting of postings) {
      const document = searchReady.documents.get(posting.chunk_id);
      if (!document) continue;
      const denominator =
        posting.term_frequency +
        k1 *
          (1 -
            b +
            b *
              (document.length /
                Math.max(1, searchReady.average_document_length)));
      const score = idf * ((posting.term_frequency * (k1 + 1)) / denominator);
      scores.set(posting.chunk_id, (scores.get(posting.chunk_id) ?? 0) + score);
    }
  }

  return scores;
}

function scoreSourceFields(
  query: string,
  queryTokens: string[],
  chunk: SourceChunk,
  relatedNodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>,
  bm25Score: number,
): {
  score_breakdown: SourceScoreBreakdown;
  match_reasons: SourceMatchReason[];
} {
  const queryLower = query.toLowerCase();
  const pathLower = chunk.file_path.toLowerCase();
  const contentLower = chunk.content.toLowerCase();
  const contentTokens = new Set(tokenize(chunk.content));
  const pathTokens = new Set(structuredPathTokens(chunk.file_path, queryTokens));
  const score_breakdown: SourceScoreBreakdown = {
    bm25: bm25Score,
    content: 0,
    export: 0,
    import: 0,
    path: 0,
    related_graph_node: 0,
    symbol: 0,
  };
  const match_reasons: SourceMatchReason[] = [];
  const reasonIndexes = new Map<string, number>();

  function addReason(
    field: SourceMatchField,
    value: string,
    score: number,
    detail?: string,
    contributesToFieldScore = true,
  ): void {
    if (contributesToFieldScore) {
      score_breakdown[field] += score;
    }
    const key = `${field}:${value}`;
    const existingIndex = reasonIndexes.get(key);
    if (existingIndex !== undefined) {
      match_reasons[existingIndex].score += score;
      return;
    }
    reasonIndexes.set(key, match_reasons.length);
    match_reasons.push({ field, value, score, detail });
  }

  if (pathLower.includes(queryLower)) {
    addReason("path", chunk.file_path, 4, "exact query matched the file path");
  }
  const exactSymbol = chunk.symbols.find((symbol) =>
    symbol.name.toLowerCase().includes(queryLower),
  );
  if (exactSymbol) {
    addReason("symbol", exactSymbol.name, 5, "exact query matched a symbol name");
  }
  if (contentLower.includes(queryLower)) {
    addReason(
      "content",
      snippetForQuery(chunk.content, queryLower),
      2,
      "exact query matched chunk content",
    );
  }

  if (bm25Score > 0) {
    const matchedTokens = queryTokens.filter((token) =>
      contentTokens.has(token),
    );
    if (matchedTokens.length > 0) {
      addReason(
        "bm25",
        matchedTokens.slice(0, 5).join(" "),
        bm25Score,
        "query terms matched indexed content",
        false,
      );
    }
  }

  for (const token of queryTokens) {
    if (pathTokens.has(token)) {
      addReason("path", chunk.file_path, 1.5, `path contains "${token}"`);
    }
    const symbol = chunk.symbols.find((entry) =>
      tokenMatchesStructuredText(entry.name, token, queryTokens),
    );
    if (symbol) {
      addReason("symbol", symbol.name, 3, `symbol contains "${token}"`);
    }
    const sourceImport = chunk.imports.find((entry) =>
      tokenMatchesStructuredText(entry.module, token, queryTokens),
    );
    if (sourceImport) {
      addReason("import", sourceImport.module, 1, `import contains "${token}"`);
    }
    const sourceExport = chunk.exports.find((entry) =>
      tokenMatchesStructuredText(entry, token, queryTokens),
    );
    if (sourceExport) {
      addReason("export", sourceExport, 1, `export contains "${token}"`);
    }
    const relatedNode = relatedNodes.find((node) =>
      tokenMatchesStructuredText(
        `${node.name} ${node.summary}`,
        token,
        queryTokens,
      ),
    );
    if (relatedNode) {
      addReason(
        "related_graph_node",
        relatedNode.id,
        1.25,
        `related graph node contains "${token}"`,
      );
    }
  }

  return {
    score_breakdown,
    match_reasons: match_reasons
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.field.localeCompare(b.field) ||
          a.value.localeCompare(b.value),
      )
      .slice(0, MAX_MATCH_REASONS),
  };
}

function diversifyRankedChunks(
  ranked: RankedChunk[],
  limit: number,
): RankedChunk[] {
  const selected: RankedChunk[] = [];
  const selectedIds = new Set<string>();
  const fileCounts = new Map<string, number>();
  const maxPerFile = Math.max(2, Math.ceil(limit / 4));

  function add(candidate: RankedChunk, maxForFile: number): void {
    if (selected.length >= limit || selectedIds.has(candidate.chunk.id)) return;
    const count = fileCounts.get(candidate.chunk.file_path) ?? 0;
    if (count >= maxForFile) return;
    selected.push(candidate);
    selectedIds.add(candidate.chunk.id);
    fileCounts.set(candidate.chunk.file_path, count + 1);
  }

  for (const candidate of ranked) add(candidate, 1);
  for (const candidate of ranked) add(candidate, maxPerFile);
  for (const candidate of ranked) add(candidate, Number.POSITIVE_INFINITY);

  return selected;
}

function filterWeakRankedChunks(ranked: RankedChunk[]): RankedChunk[] {
  const positive = ranked.filter(({ score }) => score > 0);
  const topScore = positive[0]?.score ?? 0;
  if (topScore <= 0) return [];

  const scoreFloor = Math.min(1, Math.max(0.25, topScore * 0.05));
  return positive.filter(
    (candidate, index) => index === 0 || candidate.score >= scoreFloor,
  );
}

function expandRankedWithCompanionChunks(
  ranked: RankedChunk[],
  options: {
    index: SourceIndex;
    limit: number;
    queryTokens: string[];
    relatedNodesByFile: Map<
      string,
      Array<Pick<Node, "id" | "kind" | "name" | "summary">>
    >;
    reverseImportIndex: ReverseImportIndex;
  },
): RankedChunk[] {
  if (options.limit <= 1 || ranked.length === 0) return ranked;

  const expanded: RankedChunk[] = [];
  const expandedFiles = new Set<string>();
  const companionFiles = new Set<string>();
  const seedLimit = Math.min(ranked.length, Math.max(3, options.limit));
  const maxCompanions = Math.min(
    MAX_COMPANION_CONTEXT_CANDIDATES,
    Math.max(1, options.limit - 1),
  );
  let companionCount = 0;

  for (const [index, rankedChunk] of ranked.entries()) {
    expanded.push(rankedChunk);
    expandedFiles.add(rankedChunk.chunk.file_path);
    if (index >= seedLimit || companionCount >= maxCompanions) continue;

    const companions = companionCandidatesForRankedChunk(rankedChunk, options);
    for (const companion of companions) {
      if (companionCount >= maxCompanions) break;
      if (companion.file.file_path === rankedChunk.chunk.file_path) continue;
      if (expandedFiles.has(companion.file.file_path)) continue;
      if (companionFiles.has(companion.file.file_path)) continue;

      const companionRanked = rankedChunkForCompanion(
        rankedChunk,
        companion,
        options,
      );
      if (!companionRanked) continue;

      expanded.push(companionRanked);
      companionFiles.add(companion.file.file_path);
      companionCount += 1;
    }
  }

  return expanded.sort(compareRankedChunks);
}

function companionCandidatesForRankedChunk(
  rankedChunk: RankedChunk,
  options: {
    index: SourceIndex;
    queryTokens: string[];
    reverseImportIndex: ReverseImportIndex;
  },
): CompanionCandidate[] {
  const candidates: CompanionCandidate[] = [];
  const seen = new Set<string>();

  function add(filePath: string, reason: string, priority: number): void {
    if (seen.has(filePath)) return;
    const file = options.index.files[filePath];
    if (!file) return;
    seen.add(filePath);
    candidates.push({
      file,
      reason,
      priority: priority + companionFileSignalScore(file, options.queryTokens),
    });
  }

  const importerFilePaths = new Set(
    (options.reverseImportIndex.get(rankedChunk.chunk.file_path) ?? []).map(
      ({ importer }) => importer.file_path,
    ),
  );
  for (const companion of testCompanionCandidates(
    rankedChunk.chunk.file_path,
  )) {
    if (
      companion.requiresImportMatch &&
      !importerFilePaths.has(companion.filePath)
    ) {
      continue;
    }
    add(
      companion.filePath,
      `test companion for ${rankedChunk.chunk.file_path}`,
      70,
    );
  }

  const importers =
    options.reverseImportIndex.get(rankedChunk.chunk.file_path) ?? [];
  for (const { importer } of importers) {
    if (!isCliOrToolCompanionPath(importer.file_path)) continue;
    add(
      importer.file_path,
      `local CLI/tool importer of ${rankedChunk.chunk.file_path}`,
      importer.file_path.startsWith("src/tools/") ? 62 : 60,
    );
  }

  const writebackQuery = isWritebackQuery(options.queryTokens);
  if (
    (isAgentGuidanceQuery(options.queryTokens) || writebackQuery) &&
    isAgentGuidanceSeed(rankedChunk.chunk.file_path)
  ) {
    add("AGENTS.md", "generated agent guidance for lifecycle queries", 80);
    add("src/guidance.ts", "client guidance companion for lifecycle queries", 79);
    if (writebackQuery) {
      add(
        "src/tools/suggest_writeback.ts",
        "writeback tool companion for lifecycle queries",
        78,
      );
      add(
        "src/writeback_suggestions.ts",
        "writeback suggestion engine companion for lifecycle queries",
        76,
      );
    }
  }

  if (
    isTaskIndexQuery(options.queryTokens) &&
    rankedChunk.chunk.file_path.startsWith("tasks/task-")
  ) {
    add("tasks/README.md", "task index companion for task documentation", 55);
  }

  return candidates.sort(
    (a, b) =>
      b.priority - a.priority || a.file.file_path.localeCompare(b.file.file_path),
  );
}

function rankedChunkForCompanion(
  seed: RankedChunk,
  companion: CompanionCandidate,
  options: {
    queryTokens: string[];
    relatedNodesByFile: Map<
      string,
      Array<Pick<Node, "id" | "kind" | "name" | "summary">>
    >;
  },
): RankedChunk | null {
  const chunk = companionChunkForFile(companion.file, options.queryTokens);
  if (!chunk) return null;

  const companionSignalScore = companionChunkSignalScore(
    chunk,
    options.queryTokens,
  );
  const score = Math.min(
    Math.max(COMPANION_SCORE_FLOOR, seed.score * COMPANION_SCORE_MULTIPLIER) +
      companionSignalScore,
    seed.score * COMPANION_SCORE_DIRECT_CEILING_MULTIPLIER,
  );
  const score_breakdown = zeroScoreBreakdown();
  score_breakdown.path = score;

  return {
    chunk,
    score,
    score_breakdown,
    match_reasons: [
      {
        field: "path",
        value: companion.file.file_path,
        score,
        detail: `bounded companion context: ${companion.reason}`,
      },
    ],
    related_nodes:
      options.relatedNodesByFile.get(companion.file.file_path)?.slice(0, 3) ??
      [],
  };
}

function companionChunkForFile(
  file: IndexedSourceFile,
  queryTokens: string[],
): SourceChunk | null {
  let bestChunk: SourceChunk | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const chunk of file.chunks) {
    const score = companionChunkSignalScore(chunk, queryTokens);
    if (
      score > bestScore ||
      (score === bestScore &&
        bestChunk !== null &&
        compareCompanionChunkTie(chunk, bestChunk) < 0)
    ) {
      bestChunk = chunk;
      bestScore = score;
    }
  }

  return bestChunk;
}

function compareCompanionChunkTie(a: SourceChunk, b: SourceChunk): number {
  const usefulDelta = companionChunkUsefulness(b) - companionChunkUsefulness(a);
  return usefulDelta || a.start_line - b.start_line;
}

function companionChunkUsefulness(chunk: SourceChunk): number {
  if (chunk.symbols.length > 0) return 2;
  if (chunk.chunk_type === "file") return 1;
  return 0;
}

function companionChunkSignalScore(
  chunk: SourceChunk,
  queryTokens: string[],
): number {
  const tokens = new Set([
    ...structuredPathTokens(chunk.file_path, queryTokens),
    ...tokenize(chunk.content),
    ...chunk.symbols.flatMap((symbol) => tokenize(symbol.name)),
    ...chunk.imports.flatMap((entry) => tokenize(entry.module)),
    ...chunk.exports.flatMap((entry) => tokenize(entry)),
  ]);
  return queryTokens.reduce(
    (score, token) => score + (tokens.has(token) ? 1 : 0),
    0,
  );
}

function companionFileSignalScore(
  file: IndexedSourceFile,
  queryTokens: string[],
): number {
  const tokens = new Set([
    ...structuredPathTokens(file.file_path, queryTokens),
    ...file.symbols.flatMap((symbol) => tokenize(symbol.name)),
    ...file.imports.flatMap((entry) => tokenize(entry.module)),
    ...file.exports.flatMap((entry) => tokenize(entry)),
  ]);
  return queryTokens.reduce(
    (score, token) => score + (tokens.has(token) ? 2 : 0),
    0,
  );
}

function testCompanionCandidates(filePath: string): TestCompanionCandidate[] {
  const extension = path.posix.extname(filePath);
  const withoutExtension = extension
    ? filePath.slice(0, -extension.length)
    : filePath;
  const basename = path.posix.basename(withoutExtension);
  const srcRelative = withoutExtension.startsWith("src/")
    ? withoutExtension.slice("src/".length)
    : withoutExtension;
  const pathPreservingStems = [
    `test/unit/${srcRelative}.test`,
    `test/${srcRelative}.test`,
    `tests/${srcRelative}.test`,
  ];
  const basenameFallbackStems = [
    `test/unit/${basename}.test`,
    `test/${basename}.test`,
    `tests/${basename}.test`,
  ];
  const candidates: TestCompanionCandidate[] = [
    ...pathPreservingStems.flatMap((stem) =>
      TEST_COMPANION_EXTENSIONS.map((extension) => ({
        filePath: `${stem}${extension}`,
        requiresImportMatch: false,
      })),
    ),
    ...basenameFallbackStems.flatMap((stem) =>
      TEST_COMPANION_EXTENSIONS.map((extension) => ({
        filePath: `${stem}${extension}`,
        requiresImportMatch: true,
      })),
    ),
  ];

  if (filePath.startsWith("src/cli/")) {
    candidates.push({
      filePath: "test/unit/cli.test.ts",
      requiresImportMatch: false,
    });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.filePath)) return false;
    seen.add(candidate.filePath);
    return true;
  });
}

function isCliOrToolCompanionPath(filePath: string): boolean {
  return filePath.startsWith("src/cli/") || filePath.startsWith("src/tools/");
}

function isAgentGuidanceQuery(queryTokens: string[]): boolean {
  return queryTokens.some((token) => AGENT_GUIDANCE_QUERY_TOKENS.has(token));
}

function isWritebackQuery(queryTokens: string[]): boolean {
  return queryTokens.some((token) => WRITEBACK_QUERY_TOKENS.has(token));
}

function isAgentGuidanceSeed(filePath: string): boolean {
  if (AGENT_GUIDANCE_SEED_FILES.has(filePath)) return true;
  const basename = path.posix.basename(filePath, path.posix.extname(filePath));
  return ["agentic_surfaces", "guidance", "instructions", "repo_guidance"].some(
    (token) => basename.includes(token),
  );
}

function isTaskIndexQuery(queryTokens: string[]): boolean {
  return queryTokens.some((token) => TASK_INDEX_QUERY_TOKENS.has(token));
}

function countUniqueRankedChunks(ranked: RankedChunk[]): number {
  return new Set(ranked.map(({ chunk }) => chunk.id)).size;
}

function adjustSourceScore(
  score: number,
  input: {
    chunk: SourceChunk;
    queryTokens: string[];
    score_breakdown: SourceScoreBreakdown;
    reverseImportIndex: ReverseImportIndex;
    localImportingFiles: Set<string>;
    needsRelationshipRanking: boolean;
  },
): number {
  if (score <= 0) return score;
  let adjusted = score;

  if (
    isArchivalChunk(input.chunk) &&
    !input.queryTokens.some((token) => ARCHIVAL_TOKENS.has(token))
  ) {
    adjusted *= ARCHIVAL_DEMOTION_MULTIPLIER;
  }

  if (
    input.needsRelationshipRanking &&
    isDisconnectedImplementationCandidate(
      input.chunk,
      input.reverseImportIndex,
      input.localImportingFiles,
      input.queryTokens,
    )
  ) {
    adjusted *= DISCONNECTED_IMPACT_MULTIPLIER;
  }

  if (
    isLowCoverageBm25OnlyCandidate(
      input.chunk,
      input.queryTokens,
      input.score_breakdown,
    )
  ) {
    adjusted *= LOW_COVERAGE_BM25_ONLY_MULTIPLIER;
  }

  return adjusted;
}

function isArchivalChunk(chunk: SourceChunk): boolean {
  const pathTokens = tokenize(chunk.file_path);
  if (pathTokens.some((token) => ARCHIVAL_TOKENS.has(token))) return true;

  const contentTokens = tokenize(chunk.content);
  return contentTokens.some((token) => ARCHIVAL_TOKENS.has(token));
}

function isDisconnectedImplementationCandidate(
  chunk: SourceChunk,
  reverseImportIndex: ReverseImportIndex,
  localImportingFiles: Set<string>,
  queryTokens?: string[],
): boolean {
  if (chunk.language === "markdown") return false;
  if (
    queryTokens &&
    hasExplicitPathTokenMatch(chunk.file_path, queryTokens)
  ) {
    return false;
  }
  if ((reverseImportIndex.get(chunk.file_path)?.length ?? 0) > 0) return false;
  if (localImportingFiles.has(chunk.file_path)) return false;
  return !chunk.imports.some((entry) => entry.module.startsWith("."));
}

function isLowCoverageBm25OnlyCandidate(
  chunk: SourceChunk,
  queryTokens: string[],
  scoreBreakdown: SourceScoreBreakdown,
): boolean {
  if (queryTokens.length < 4) return false;
  if (scoreBreakdown.bm25 <= 0) return false;

  const structuredScore =
    scoreBreakdown.content +
    scoreBreakdown.export +
    scoreBreakdown.import +
    scoreBreakdown.path +
    scoreBreakdown.related_graph_node +
    scoreBreakdown.symbol;
  if (structuredScore > 0) return false;

  const contentTokens = new Set(tokenize(chunk.content));
  let matchedTokens = 0;
  for (const token of new Set(queryTokens)) {
    if (contentTokens.has(token)) matchedTokens += 1;
    if (matchedTokens > 1) return false;
  }

  return matchedTokens <= 1;
}

function hasExplicitPathTokenMatch(
  filePath: string,
  queryTokens: string[],
): boolean {
  const fileName = path.posix.basename(
    filePath,
    path.posix.extname(filePath),
  );
  const pathTokens = new Set(structuredPathTokens(fileName, queryTokens));
  return queryTokens.some(
    (token) => pathTokens.has(token) && !GENERIC_PATH_TOKENS.has(token),
  );
}

function zeroScoreBreakdown(): SourceScoreBreakdown {
  return {
    bm25: 0,
    content: 0,
    export: 0,
    import: 0,
    path: 0,
    related_graph_node: 0,
    symbol: 0,
  };
}

function roundScoreBreakdown(
  breakdown: SourceScoreBreakdown,
): SourceScoreBreakdown {
  return {
    bm25: Number(breakdown.bm25.toFixed(4)),
    content: Number(breakdown.content.toFixed(4)),
    export: Number(breakdown.export.toFixed(4)),
    import: Number(breakdown.import.toFixed(4)),
    path: Number(breakdown.path.toFixed(4)),
    related_graph_node: Number(breakdown.related_graph_node.toFixed(4)),
    symbol: Number(breakdown.symbol.toFixed(4)),
  };
}

function roundMatchReasons(reasons: SourceMatchReason[]): SourceMatchReason[] {
  return reasons.map((reason) => ({
    ...reason,
    score: Number(reason.score.toFixed(4)),
  }));
}

function snippetForQuery(value: string, queryLower: string): string {
  const lower = value.toLowerCase();
  const index = lower.indexOf(queryLower);
  if (index < 0) return value.slice(0, 80);
  const start = Math.max(0, index - 24);
  const end = Math.min(value.length, index + queryLower.length + 56);
  return value.slice(start, end);
}

async function loadRelatedNodesByFile(
  repoRoot: string,
): Promise<Map<string, Array<Pick<Node, "id" | "kind" | "name" | "summary">>>> {
  const byFile = new Map<
    string,
    Array<Pick<Node, "id" | "kind" | "name" | "summary">>
  >();
  try {
    const store = await GraphStore.load(repoRoot);
    for (const [id, node] of Object.entries(store._data().nodes)) {
      for (const source of node.sources) {
        const existing = byFile.get(source.file_path) ?? [];
        if (!existing.some((related) => related.id === id)) {
          existing.push({
            id,
            kind: node.kind,
            name: node.name,
            summary: node.summary,
          });
        }
        byFile.set(source.file_path, existing);
      }
    }
  } catch {
    // Source search should still work if the curated graph is absent/invalid.
  }
  return byFile;
}

function buildDependencyContext(
  index: SourceIndex,
  filePath: string,
  limit: number,
  maxContentChars: number,
  reverseImportIndex: ReverseImportIndex,
): SourceDependencyContext[] {
  if (limit <= 0) return [];

  const targetFile = index.files[filePath];
  if (!targetFile) return [];

  const dependencies: SourceDependencyContext[] = [];
  const seen = new Set<string>();

  function addDependency(
    direction: SourceDependencyDirection,
    file: IndexedSourceFile,
    sourceImport: SourceImport,
  ) {
    const key = `${direction}:${file.file_path}`;
    if (seen.has(key) || dependencies.length >= limit) return;
    seen.add(key);
    dependencies.push({
      direction,
      file_path: file.file_path,
      module: sourceImport.module,
      import_line: sourceImport.line,
      symbols: file.symbols.slice(0, 5),
      imports: file.imports.slice(0, 10),
      exports: file.exports.slice(0, 10),
      content_preview: filePreview(file, maxContentChars),
    });
  }

  for (const sourceImport of targetFile.imports) {
    const resolved = resolveImportPath(
      index,
      targetFile.file_path,
      sourceImport.module,
    );
    if (!resolved) continue;
    const importedFile = index.files[resolved];
    if (importedFile) {
      addDependency("imports", importedFile, sourceImport);
    }
  }

  if (dependencies.length >= limit) return dependencies;

  const importers = reverseImportIndex.get(filePath) ?? [];
  for (const { importer, importEntry } of importers) {
    if (importer.file_path !== filePath) {
      addDependency("imported_by", importer, importEntry);
    }
    if (dependencies.length >= limit) return dependencies;
  }

  return dependencies;
}

function buildImpactContext(
  index: SourceIndex,
  chunk: SourceChunk,
  query: string,
  limit: number,
  maxContentChars: number,
  reverseImportIndex: ReverseImportIndex,
): SourceImpactContext {
  const targetFile = index.files[chunk.file_path];
  if (!targetFile) {
    return emptyImpactContext(chunk.file_path);
  }

  const queryTokens = tokenize(query);
  const matchedSymbol = chooseTargetSymbol(chunk, targetFile, query, queryTokens);
  const definitions = matchedSymbol
    ? findSymbolDefinitions(index, matchedSymbol.name, limit, maxContentChars)
    : [];
  const imports = buildImportImpactReferences(
    index,
    targetFile,
    limit,
    maxContentChars,
  );
  const importedBy = buildImporterImpactReferences(
    targetFile.file_path,
    reverseImportIndex,
    limit,
    maxContentChars,
  );
  const approximateReferences = matchedSymbol
    ? buildApproximateReferences(
        index,
        matchedSymbol.name,
        targetFile.file_path,
        limit,
        maxContentChars,
      )
    : [];
  const likelyAffectedFiles = [
    ...new Set([
      ...importedBy.map((entry) => entry.file_path),
      ...approximateReferences.map((entry) => entry.file_path),
    ]),
  ]
    .filter((filePath) => filePath !== targetFile.file_path)
    .slice(0, limit);
  const ambiguous = definitions.length > 1;
  const warnings: string[] = [];
  if (ambiguous && matchedSymbol) {
    warnings.push(
      `Symbol "${matchedSymbol.name}" has multiple indexed definitions; inspect each definition before editing.`,
    );
  }
  if (approximateReferences.length > 0) {
    warnings.push(
      "Approximate references are lexical matches from the source index, not a full call graph.",
    );
  }

  return {
    target: {
      type: matchedSymbol ? "symbol" : "file",
      value: matchedSymbol?.name ?? targetFile.file_path,
      file_path: targetFile.file_path,
      ambiguous,
      matched_symbol: matchedSymbol,
    },
    definitions,
    imports,
    imported_by: importedBy,
    exported_symbols: exportedSymbols(targetFile, limit),
    likely_affected_files: likelyAffectedFiles,
    approximate_references: approximateReferences,
    warnings,
  };
}

function emptyImpactContext(
  filePath: string,
): SourceImpactContext {
  return {
    target: {
      type: "file",
      value: filePath,
      file_path: filePath,
      ambiguous: false,
    },
    definitions: [],
    imports: [],
    imported_by: [],
    exported_symbols: [],
    likely_affected_files: [],
    approximate_references: [],
    warnings: [],
  };
}

function chooseTargetSymbol(
  chunk: SourceChunk,
  file: IndexedSourceFile,
  query: string,
  queryTokens: string[],
): SourceSymbol | undefined {
  const queryLower = query.toLowerCase();
  const candidates = [...chunk.symbols, ...file.symbols].filter(
    (symbol, index, symbols) =>
      symbols.findIndex((entry) => entry.name === symbol.name) === index,
  );

  return candidates
    .map((symbol) => ({
      symbol,
      score: symbolQueryScore(symbol.name, queryLower, queryTokens),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.symbol.line - b.symbol.line ||
        a.symbol.name.localeCompare(b.symbol.name),
    )[0]?.symbol;
}

function symbolQueryScore(
  symbolName: string,
  queryLower: string,
  queryTokens: string[],
): number {
  const symbolLower = symbolName.toLowerCase();
  if (symbolLower === queryLower) return 100;
  if (queryLower.includes(symbolLower)) return 90;
  if (symbolLower.includes(queryLower)) return 80;

  let score = 0;
  for (const token of queryTokens) {
    if (symbolLower === token) score += 50;
    else if (symbolLower.includes(token)) score += 10;
  }
  return score;
}

function findSymbolDefinitions(
  index: SourceIndex,
  symbolName: string,
  limit: number,
  maxContentChars: number,
): SourceImpactReference[] {
  const definitions: SourceImpactReference[] = [];
  const files = Object.values(index.files).sort((a, b) =>
    a.file_path.localeCompare(b.file_path),
  );

  for (const file of files) {
    for (const symbol of file.symbols) {
      if (symbol.name !== symbolName) continue;
      const chunk = chunkForSymbol(file, symbol);
      definitions.push({
        kind: "definition",
        precision: "exact",
        file_path: file.file_path,
        start_line: chunk?.start_line ?? symbol.line,
        end_line: chunk?.end_line ?? symbol.end_line ?? symbol.line,
        symbol,
        reason: `indexed ${symbol.kind} definition for ${symbol.name}`,
        content_preview: boundedPreview(
          chunk?.content ?? "",
          maxContentChars,
        ),
      });
      if (definitions.length >= limit) return definitions;
    }
  }

  return definitions;
}

function buildImportImpactReferences(
  index: SourceIndex,
  file: IndexedSourceFile,
  limit: number,
  maxContentChars: number,
): SourceImpactReference[] {
  const references: SourceImpactReference[] = [];
  const seen = new Set<string>();

  for (const sourceImport of file.imports) {
    const resolved = resolveImportPath(
      index,
      file.file_path,
      sourceImport.module,
    );
    if (!resolved || seen.has(resolved)) continue;
    const importedFile = index.files[resolved];
    if (!importedFile) continue;
    seen.add(resolved);
    references.push({
      kind: "import",
      precision: "exact",
      file_path: importedFile.file_path,
      start_line: 1,
      end_line: 1,
      module: sourceImport.module,
      import_line: sourceImport.line,
      reason: `${file.file_path} imports ${importedFile.file_path}`,
      content_preview: filePreview(importedFile, maxContentChars),
    });
    if (references.length >= limit) return references;
  }

  return references;
}

function buildImporterImpactReferences(
  filePath: string,
  reverseImportIndex: ReverseImportIndex,
  limit: number,
  maxContentChars: number,
): SourceImpactReference[] {
  const references: SourceImpactReference[] = [];
  const seen = new Set<string>();
  const importers = reverseImportIndex.get(filePath) ?? [];

  for (const { importer, importEntry } of importers) {
    if (importer.file_path === filePath || seen.has(importer.file_path)) {
      continue;
    }
    seen.add(importer.file_path);
    references.push({
      kind: "imported_by",
      precision: "exact",
      file_path: importer.file_path,
      start_line: importEntry.line,
      end_line: importEntry.end_line ?? importEntry.line,
      module: importEntry.module,
      import_line: importEntry.line,
      reason: `${importer.file_path} imports ${filePath}`,
      content_preview: filePreview(importer, maxContentChars),
    });
    if (references.length >= limit) return references;
  }

  return references;
}

function buildApproximateReferences(
  index: SourceIndex,
  symbolName: string,
  definingFilePath: string,
  limit: number,
  maxContentChars: number,
): SourceImpactReference[] {
  const references: SourceImpactReference[] = [];
  const symbolLower = symbolName.toLowerCase();
  const files = Object.values(index.files).sort((a, b) =>
    a.file_path.localeCompare(b.file_path),
  );

  for (const file of files) {
    const exactReferences = file.references?.filter(
      (reference) => reference.name === symbolName,
    );
    const referencesMayBeTruncated =
      file.references_truncated === true ||
      (file.references_truncated === undefined &&
        (file.references?.length ?? 0) >= MAX_REFERENCES_PER_FILE);
    let exactCoverageEndLine = 0;
    if (exactReferences && exactReferences.length > 0) {
      const definitionLines = definitionReferenceLines(file, symbolName);
      for (const reference of exactReferences) {
        if (
          file.file_path === definingFilePath &&
          definitionLines.has(reference.start_line)
        ) {
          continue;
        }
        exactCoverageEndLine = Math.max(
          exactCoverageEndLine,
          reference.end_line,
        );
        const chunk = chunkForLine(file, reference.start_line);
        const preview = chunk
          ? chunkContentRange(chunk, reference.start_line, reference.end_line)
          : "";
        references.push({
          kind: "text_reference",
          precision: "approximate",
          file_path: file.file_path,
          start_line: reference.start_line,
          end_line: reference.end_line,
          reason: `identifier reference mentions ${symbolName}`,
          content_preview: boundedPreview(preview, maxContentChars),
        });
        if (references.length >= limit) return references;
      }
      if (!referencesMayBeTruncated) continue;
    }

    const shouldSearchChunks =
      exactReferences === undefined ||
      exactReferences.length === 0 ||
      (referencesMayBeTruncated &&
        file.chunks.some((chunk) => chunk.end_line > exactCoverageEndLine));
    if (!shouldSearchChunks) continue;

    for (const chunk of file.chunks) {
      const searchableStartLine = Math.max(
        chunk.start_line,
        exactCoverageEndLine + 1,
      );
      if (searchableStartLine > chunk.end_line) continue;
      const searchableContent = chunkContentFromLine(chunk, searchableStartLine);
      if (!searchableContent.toLowerCase().includes(symbolLower)) continue;
      if (
        file.file_path === definingFilePath &&
        chunk.symbols.some((symbol) => symbol.name === symbolName)
      ) {
        continue;
      }
      references.push({
        kind: "text_reference",
        precision: "approximate",
        file_path: file.file_path,
        start_line: searchableStartLine,
        end_line: chunk.end_line,
        reason: `chunk text mentions ${symbolName}`,
        content_preview: boundedPreview(searchableContent, maxContentChars),
      });
      if (references.length >= limit) return references;
    }
  }

  return references;
}

function definitionReferenceLines(
  file: IndexedSourceFile,
  symbolName: string,
): Set<number> {
  const lines = new Set<number>();
  for (const symbol of file.symbols) {
    if (symbol.name !== symbolName) continue;
    lines.add(symbol.line);
    if (symbol.name_line !== undefined) lines.add(symbol.name_line);
  }
  return lines;
}

function chunkContentFromLine(chunk: SourceChunk, startLine: number): string {
  return chunkContentRange(chunk, startLine, chunk.end_line);
}

function chunkContentRange(
  chunk: SourceChunk,
  startLine: number,
  endLine: number,
): string {
  const lines = chunk.content.split(/\r?\n/);
  const startOffset = Math.max(0, startLine - chunk.start_line);
  const endOffset = Math.min(
    lines.length,
    Math.max(startOffset + 1, endLine - chunk.start_line + 1),
  );
  if (startOffset === 0 && endOffset === lines.length) return chunk.content;
  const lineEnding = chunk.content.includes("\r\n") ? "\r\n" : "\n";
  return lines.slice(startOffset, endOffset).join(lineEnding);
}

function exportedSymbols(
  file: IndexedSourceFile,
  limit: number,
): SourceSymbol[] {
  return file.symbols
    .filter((symbol) => symbol.exported || file.exports.includes(symbol.name))
    .slice(0, limit);
}

function chunkForSymbol(
  file: IndexedSourceFile,
  symbol: SourceSymbol,
): SourceChunk | undefined {
  return chunkForLine(file, symbol.line);
}

function chunkForLine(
  file: IndexedSourceFile,
  line: number,
): SourceChunk | undefined {
  return file.chunks.find(
    (chunk) => chunk.start_line <= line && chunk.end_line >= line,
  );
}

function buildImportRelationshipIndex(index: SourceIndex): ImportRelationshipIndex {
  const reverseIndex: ReverseImportIndex = new Map();
  const localImportingFiles = new Set<string>();
  const files = Object.values(index.files).sort((a, b) =>
    a.file_path.localeCompare(b.file_path),
  );

  for (const file of files) {
    for (const importEntry of file.imports) {
      const resolved = resolveImportPath(
        index,
        file.file_path,
        importEntry.module,
      );
      if (!resolved) continue;
      localImportingFiles.add(file.file_path);

      const reference = { importer: file, importEntry };
      const existing = reverseIndex.get(resolved);
      if (existing) {
        existing.push(reference);
      } else {
        reverseIndex.set(resolved, [reference]);
      }
    }
  }

  return { reverseImportIndex: reverseIndex, localImportingFiles };
}

function resolveImportPath(
  index: SourceIndex,
  fromFilePath: string,
  moduleSpecifier: string,
): string | null {
  if (!moduleSpecifier.startsWith(".")) {
    return resolveNonRelativeImportPath(index, moduleSpecifier);
  }

  const baseDir = path.posix.dirname(fromFilePath);
  const unresolved = path.posix.normalize(
    path.posix.join(baseDir, moduleSpecifier),
  );
  if (unresolved.startsWith("../") || path.posix.isAbsolute(unresolved)) {
    return null;
  }

  return resolveImportBase(index, unresolved);
}

function resolveNonRelativeImportPath(
  index: SourceIndex,
  moduleSpecifier: string,
): string | null {
  const bases = nonRelativeImportBaseCandidates(moduleSpecifier);
  for (const base of bases) {
    const resolved = resolveImportBase(index, base);
    if (resolved) return resolved;
  }
  return null;
}

function nonRelativeImportBaseCandidates(moduleSpecifier: string): string[] {
  const bases: string[] = [];
  const add = (candidate: string): void => {
    const normalized = normalizePath(candidate).replace(/^\/+/, "");
    if (
      normalized &&
      !normalized.startsWith("../") &&
      !bases.includes(normalized)
    ) {
      bases.push(normalized);
    }
  };

  if (moduleSpecifier.startsWith("@/")) {
    const aliasTarget = moduleSpecifier.slice(2);
    add(`src/${aliasTarget}`);
    add(aliasTarget);
    return bases;
  }
  if (moduleSpecifier.startsWith("~/")) {
    const aliasTarget = moduleSpecifier.slice(2);
    add(`src/${aliasTarget}`);
    add(aliasTarget);
    return bases;
  }
  if (moduleSpecifier.startsWith("#/")) {
    const aliasTarget = moduleSpecifier.slice(2);
    add(aliasTarget);
    add(`src/${aliasTarget}`);
    return bases;
  }

  if (
    LOCAL_ROOT_IMPORT_PREFIXES.some((prefix) =>
      moduleSpecifier.startsWith(prefix),
    )
  ) {
    add(moduleSpecifier);
  }

  return bases;
}

function resolveImportBase(
  index: SourceIndex,
  unresolved: string,
): string | null {
  const explicitExtension = path.posix.extname(unresolved);
  const baseWithoutExtension = explicitExtension
    ? unresolved.slice(0, -explicitExtension.length)
    : unresolved;
  const supportedExtensions = [...SUPPORTED_EXTENSIONS.keys()];
  const candidates = [
    unresolved,
    ...supportedExtensions.map((extension) => `${unresolved}${extension}`),
    ...(explicitExtension
      ? supportedExtensions.map(
          (extension) => `${baseWithoutExtension}${extension}`,
        )
      : []),
    ...supportedExtensions.map((extension) => `${unresolved}/index${extension}`),
    ...supportedExtensions.map((extension) => `${unresolved}/mod${extension}`),
    ...(explicitExtension
      ? supportedExtensions.map(
          (extension) => `${baseWithoutExtension}/index${extension}`,
        )
      : []),
    ...(explicitExtension
      ? supportedExtensions.map(
          (extension) => `${baseWithoutExtension}/mod${extension}`,
        )
      : []),
  ];

  return candidates.find((candidate) => index.files[candidate]) ?? null;
}

function filePreview(file: IndexedSourceFile, maxContentChars: number): string {
  const content = file.chunks.find((chunk) => chunk.content.trim().length > 0)
    ?.content ?? "";
  return boundedPreview(content, maxContentChars);
}

function boundedPreview(content: string, maxContentChars: number): string {
  if (content.length <= maxContentChars) return content;
  return `${content.slice(0, maxContentChars)}\n// ... truncated`;
}

function chunkDocument(chunk: SourceChunk): string {
  return [
    chunk.file_path,
    chunk.chunk_type,
    chunk.symbols.map((s) => `${s.kind} ${s.name}`).join(" "),
    chunk.imports.map((i) => i.module).join(" "),
    chunk.exports.join(" "),
    chunk.content,
  ].join("\n");
}

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((token) => token.length > 1);
}

function searchQueryTokens(value: string): string[] {
  return tokenize(value).filter((token) => !QUERY_STOP_WORDS.has(token));
}

function structuredPathTokens(value: string, queryTokens: string[]): string[] {
  const expanded = new Set(tokenize(value));
  if (shouldUseStructuredSegmentFallback(value, queryTokens)) {
    for (const token of structuredSegmentTokens(value)) {
      expanded.add(token);
    }
  }
  return Array.from(expanded);
}

function tokenMatchesStructuredText(
  value: string,
  token: string,
  queryTokens: string[],
): boolean {
  if (tokenize(value).includes(token)) return true;
  if (!shouldUseStructuredSegmentFallback(value, queryTokens)) return false;
  return structuredSegmentTokens(value).includes(token);
}

function shouldUseStructuredSegmentFallback(
  value: string,
  queryTokens: string[],
): boolean {
  const segments = new Set(structuredSegmentTokens(value));
  if (segments.size < 2) return false;

  const queryTokenSet = new Set(queryTokens);
  if (![...segments].every((segment) => queryTokenSet.has(segment))) {
    return false;
  }

  const signalTokens = queryTokens.filter(
    (token) =>
      !GENERIC_PATH_TOKENS.has(token) &&
      !IMPACT_REVIEW_TOKENS.has(token) &&
      token !== "need" &&
      token !== "needs",
  );
  return signalTokens.length <= segments.size + 1;
}

function structuredSegmentTokens(value: string): string[] {
  const segments = new Set<string>();
  for (const token of tokenize(value)) {
    if (!token.includes("_")) continue;
    for (const part of token.split("_")) {
      if (part.length > 1 && !GENERIC_PATH_TOKENS.has(part)) {
        segments.add(part);
      }
    }
  }
  return Array.from(segments);
}

function isImpactReviewQuery(queryTokens: string[]): boolean {
  return queryTokens.some((token) => IMPACT_REVIEW_TOKENS.has(token));
}

function isGeneratedPath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  return GENERATED_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hashString(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashBuffer(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeysDeep(entry)]),
    );
  }
  return value;
}
