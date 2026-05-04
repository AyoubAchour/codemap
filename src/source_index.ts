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
  content: string;
  symbols: SourceSymbol[];
  imports: SourceImport[];
  exports: string[];
  related_nodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>;
}

export interface SourceSearchResponse {
  ok: boolean;
  query: string;
  index_updated_at?: string;
  search_time_ms: number;
  total_results: number;
  results: SourceSearchResult[];
  error?: { code: string; message: string };
}

interface CandidateFile {
  file_path: string;
  absolute_path: string;
  language: string;
  size_bytes: number;
  mtime_ms: number;
}

interface CandidateFileSearchResult {
  candidates: CandidateFile[];
  skippedCount: number;
}

interface RankedChunk {
  chunk: SourceChunk;
  score: number;
  related_nodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>;
}

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
  options: { limit?: number; maxContentChars?: number } = {},
): Promise<SourceSearchResponse> {
  const startedAt = Date.now();
  const trimmedQuery = query.trim();
  const limit = options.limit ?? 5;
  const maxContentChars = options.maxContentChars ?? 2400;

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

  const chunks = Object.values(index.files).flatMap((file) => file.chunks);
  const relatedNodesByFile = await loadRelatedNodesByFile(repoRoot);
  const allRanked = rankChunks(trimmedQuery, chunks, relatedNodesByFile).filter(
    ({ score }) => score > 0,
  );
  const ranked = allRanked
    .slice(0, limit)
    .map(({ chunk, score, related_nodes }) => ({
      file_path: chunk.file_path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      language: chunk.language,
      chunk_type: chunk.chunk_type,
      score: Number(score.toFixed(4)),
      content:
        chunk.content.length > maxContentChars
          ? `${chunk.content.slice(0, maxContentChars)}\n// ... truncated`
          : chunk.content,
      symbols: chunk.symbols,
      imports: chunk.imports,
      exports: chunk.exports,
      related_nodes,
    }));

  return {
    ok: true,
    query,
    index_updated_at: index.updated_at,
    search_time_ms: Date.now() - startedAt,
    total_results: allRanked.length,
    results: ranked,
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
      const score =
        bm25(queryTokens, tokens, df, documents.length, avgLength) +
        fieldBoost(query, queryTokens, chunk, relatedNodes);
      return { chunk, score, related_nodes: relatedNodes.slice(0, 3) };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);
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

function fieldBoost(
  query: string,
  queryTokens: string[],
  chunk: SourceChunk,
  relatedNodes: Array<Pick<Node, "id" | "kind" | "name" | "summary">>,
): number {
  const queryLower = query.toLowerCase();
  const pathLower = chunk.file_path.toLowerCase();
  const symbolText = chunk.symbols.map((s) => s.name).join(" ").toLowerCase();
  const importText = chunk.imports.map((i) => i.module).join(" ").toLowerCase();
  const exportText = chunk.exports.join(" ").toLowerCase();
  const contentLower = chunk.content.toLowerCase();
  const relatedText = relatedNodes
    .map((node) => `${node.name} ${node.summary}`)
    .join(" ")
    .toLowerCase();
  let boost = 0;

  if (pathLower.includes(queryLower)) boost += 4;
  if (symbolText.includes(queryLower)) boost += 5;
  if (contentLower.includes(queryLower)) boost += 2;

  for (const token of queryTokens) {
    if (pathLower.includes(token)) boost += 1.5;
    if (symbolText.includes(token)) boost += 3;
    if (importText.includes(token)) boost += 1;
    if (exportText.includes(token)) boost += 1;
    if (relatedText.includes(token)) boost += 1.25;
  }

  return boost;
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
