import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { lock } from "proper-lockfile";

import { GraphStore } from "./graph.js";
import type { Node } from "./types.js";
import { ensureSeedFile } from "./util/lock.js";

const INDEX_VERSION = 1 as const;
const INDEX_DIR = ".codemap/index";
const INDEX_FILE = "source.json";
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

const SUPPORTED_EXTENSIONS = new Map<string, string>([
  [".cjs", "javascript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".mts", "typescript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
]);

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

export interface SourceSymbol {
  name: string;
  kind: "class" | "const" | "enum" | "function" | "interface" | "type";
  line: number;
  exported: boolean;
}

export interface SourceImport {
  module: string;
  line: number;
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
}

interface CandidateFile {
  file_path: string;
  absolute_path: string;
  language: string;
  size_bytes: number;
  mtime_ms: number;
}

interface ReverseImportReference {
  importer: IndexedSourceFile;
  importEntry: SourceImport;
}

type ReverseImportIndex = Map<string, ReverseImportReference[]>;

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

const MAX_MATCH_REASONS = 8;

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
      fresh: false,
    };
  }

  const { candidates: currentFiles } = await findCandidateFiles(repoRoot, {
    maxFileBytes: index.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES,
  });
  const currentByPath = new Map(
    currentFiles.map((file) => [file.file_path, file] as const),
  );
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
    indexed: true,
    index_path: indexPath,
    updated_at: index.updated_at,
    files_indexed: index.stats.files_indexed,
    chunks_indexed: index.stats.chunks_indexed,
    symbols_indexed: index.stats.symbols_indexed,
    stale_files: staleFiles,
    missing_files: missingFiles,
    new_files: newFiles,
    fresh: staleFiles === 0 && missingFiles === 0 && newFiles === 0,
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

  let index: SourceIndex | null;
  try {
    index = await loadSourceIndex(repoRoot);
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
  const status = await getSourceIndexStatus(repoRoot);
  if (status.indexed && !status.fresh) {
    warnings.push(
      "Source index is stale; refresh with codemap scan or index_codebase before relying on source hits.",
    );
  }

  const chunks = Object.values(index.files).flatMap((file) => file.chunks);
  const relatedNodesByFile = await loadRelatedNodesByFile(repoRoot);
  const reverseImportIndex =
    dependencyLimit > 0 || includeImpact
      ? buildReverseImportIndex(index)
      : new Map();
  const allRanked = rankChunks(trimmedQuery, chunks, relatedNodesByFile).filter(
    ({ score }) => score > 0,
  );
  const ranked = diversifyRankedChunks(allRanked, limit)
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
        reverseImportIndex,
      ),
      impact_context: includeImpact
        ? buildImpactContext(
            index,
            chunk,
            trimmedQuery,
            impactLimit,
            impactContentChars,
            reverseImportIndex,
          )
        : undefined,
    }));

  return {
    ok: true,
    query,
    index_updated_at: index.updated_at,
    search_time_ms: Date.now() - startedAt,
    total_results: allRanked.length,
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
      const extension = path.extname(entry.name);
      const language = SUPPORTED_EXTENSIONS.get(extension);
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
        file_path: normalizePath(relativePath),
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

function indexFile(
  candidate: CandidateFile,
  content: string,
  indexedAt: string,
): IndexedSourceFile {
  const lines = content.split(/\r?\n/);
  const contentHash = hashString(content);
  const imports = extractImports(lines);
  const exports = extractExports(lines);
  const symbols = extractSymbols(lines);
  const chunks = createChunks(candidate, lines, contentHash, symbols, imports, exports);

  return {
    file_path: candidate.file_path,
    language: candidate.language,
    size_bytes: candidate.size_bytes,
    mtime_ms: candidate.mtime_ms,
    line_count: lines.length,
    content_hash: contentHash,
    indexed_at: indexedAt,
    imports,
    exports,
    symbols,
    chunks,
  };
}

function extractImports(lines: string[]): SourceImport[] {
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
      imports.push({ module: match[1], line: index + 1 });
    }
  });

  return imports;
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

function extractSymbols(lines: string[]): SourceSymbol[] {
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
          exported: /\bexport\b/.test(line),
        });
        break;
      }
    }
  });

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

function rankChunks(
  query: string,
  chunks: SourceChunk[],
  relatedNodesByFile: Map<
    string,
    Array<Pick<Node, "id" | "kind" | "name" | "summary">>
  >,
): RankedChunk[] {
  const queryTokens = tokenize(query);
  const documents = chunks.map((chunk) => ({
    chunk,
    tokens: tokenize(chunkDocument(chunk)),
  }));
  const avgLength =
    documents.reduce((sum, doc) => sum + doc.tokens.length, 0) /
    Math.max(1, documents.length);
  const df = new Map<string, number>();
  for (const doc of documents) {
    for (const token of new Set(doc.tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  return documents
    .map(({ chunk, tokens }) => {
      const relatedNodes = relatedNodesByFile.get(chunk.file_path) ?? [];
      const bm25Score = bm25(
        queryTokens,
        tokens,
        df,
        documents.length,
        avgLength,
      );
      const fieldScore = scoreSourceFields(
        query,
        queryTokens,
        chunk,
        relatedNodes,
        bm25Score,
      );
      const score =
        fieldScore.score_breakdown.bm25 +
        fieldScore.score_breakdown.content +
        fieldScore.score_breakdown.export +
        fieldScore.score_breakdown.import +
        fieldScore.score_breakdown.path +
        fieldScore.score_breakdown.related_graph_node +
        fieldScore.score_breakdown.symbol;
      return {
        chunk,
        score,
        score_breakdown: fieldScore.score_breakdown,
        match_reasons: fieldScore.match_reasons,
        related_nodes: relatedNodes.slice(0, 3),
      };
    })
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.chunk.file_path.localeCompare(b.chunk.file_path) ||
        a.chunk.start_line - b.chunk.start_line,
    );
}

function bm25(
  queryTokens: string[],
  documentTokens: string[],
  df: Map<string, number>,
  documentCount: number,
  avgDocumentLength: number,
): number {
  const k1 = 1.2;
  const b = 0.75;
  const frequencies = new Map<string, number>();
  for (const token of documentTokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  let score = 0;
  for (const token of new Set(queryTokens)) {
    const termFrequency = frequencies.get(token) ?? 0;
    if (termFrequency === 0) continue;
    const documentFrequency = df.get(token) ?? 0;
    const idf = Math.log(
      1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
    const denominator =
      termFrequency +
      k1 *
        (1 -
          b +
          b * (documentTokens.length / Math.max(1, avgDocumentLength)));
    score += idf * ((termFrequency * (k1 + 1)) / denominator);
  }
  return score;
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
      contentLower.includes(token),
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
    if (pathLower.includes(token)) {
      addReason("path", chunk.file_path, 1.5, `path contains "${token}"`);
    }
    const symbol = chunk.symbols.find((entry) =>
      entry.name.toLowerCase().includes(token),
    );
    if (symbol) {
      addReason("symbol", symbol.name, 3, `symbol contains "${token}"`);
    }
    const sourceImport = chunk.imports.find((entry) =>
      entry.module.toLowerCase().includes(token),
    );
    if (sourceImport) {
      addReason("import", sourceImport.module, 1, `import contains "${token}"`);
    }
    const sourceExport = chunk.exports.find((entry) =>
      entry.toLowerCase().includes(token),
    );
    if (sourceExport) {
      addReason("export", sourceExport, 1, `export contains "${token}"`);
    }
    const relatedNode = relatedNodes.find((node) =>
      `${node.name} ${node.summary}`.toLowerCase().includes(token),
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
        end_line: chunk?.end_line ?? symbol.line,
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
      end_line: importEntry.line,
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
    for (const chunk of file.chunks) {
      if (!chunk.content.toLowerCase().includes(symbolLower)) continue;
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
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        reason: `chunk text mentions ${symbolName}`,
        content_preview: boundedPreview(chunk.content, maxContentChars),
      });
      if (references.length >= limit) return references;
    }
  }

  return references;
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
  return file.chunks.find(
    (chunk) =>
      chunk.start_line <= symbol.line &&
      chunk.end_line >= symbol.line,
  );
}

function buildReverseImportIndex(index: SourceIndex): ReverseImportIndex {
  const reverseIndex: ReverseImportIndex = new Map();
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

      const reference = { importer: file, importEntry };
      const existing = reverseIndex.get(resolved);
      if (existing) {
        existing.push(reference);
      } else {
        reverseIndex.set(resolved, [reference]);
      }
    }
  }

  return reverseIndex;
}

function resolveImportPath(
  index: SourceIndex,
  fromFilePath: string,
  moduleSpecifier: string,
): string | null {
  if (!moduleSpecifier.startsWith(".")) return null;

  const baseDir = path.posix.dirname(fromFilePath);
  const unresolved = path.posix.normalize(
    path.posix.join(baseDir, moduleSpecifier),
  );
  if (unresolved.startsWith("../") || path.posix.isAbsolute(unresolved)) {
    return null;
  }

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
    ...(explicitExtension
      ? supportedExtensions.map(
          (extension) => `${baseWithoutExtension}/index${extension}`,
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
