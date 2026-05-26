import {
  buildCaptureSummaries,
  type CaptureProfile,
  type CaptureSessionSummaryRecord,
} from "./capture_summaries.js";
import { GraphStore, type QueryResult } from "./graph.js";
import {
  filterStalenessReportForNodes,
  rankGraphResultByQuality,
  summarizeGraphMemoryQuality,
} from "./graph_quality.js";
import {
  getSourceIndexStatus,
  loadSourceIndex,
  type SourceIndex,
  type SourceIndexStatus,
  type SourceSearchResponse,
  type SourceSearchResult,
  scanSourceIndex,
  searchSourceIndex,
} from "./source_index.js";
import { checkSourceStaleness, type StalenessReport } from "./staleness.js";
import type { Node } from "./types.js";

export type RecallContextMode = "mixed" | "graph" | "source";
export type RecallRefreshMode = "never" | "if_missing" | "if_stale";

export interface RecallContextOptions {
  mode?: RecallContextMode;
  limit?: number;
  budgetBytes?: number;
  maxContentChars?: number;
  refreshIndex?: RecallRefreshMode;
  files?: string[];
  symbols?: string[];
  includeCaptureSummary?: boolean;
}

export interface RecallAnchor {
  file_path: string;
  line_range: number[];
}

export interface RecallGraphResult {
  kind: "graph";
  provenance: "curated_graph";
  id: string;
  node_kind: Node["kind"];
  name: string;
  summary: string;
  score?: number;
  ranking_score?: number;
  trust?: string;
  freshness?: string;
  match_reasons: string[];
  quality_reasons: string[];
  anchors: RecallAnchor[];
}

export interface RecallSourceResult {
  kind: "source";
  provenance: "rebuildable_source_index";
  file_path: string;
  line_range: number[];
  chunk_type: string;
  score: number;
  snippet: string;
  symbols: string[];
  match_reasons: string[];
  anchors: RecallAnchor[];
}

export interface RecallCaptureSummaryResult {
  kind: "capture_summary";
  provenance: "rebuildable_capture_summary";
  scope: "session" | "profile";
  session_id?: string;
  title: string;
  summary: string;
  event_count: number;
  files: string[];
  stale_anchors: number;
  match_reasons: string[];
  anchors: RecallAnchor[];
  warnings: string[];
}

export type RecallResult =
  | RecallGraphResult
  | RecallSourceResult
  | RecallCaptureSummaryResult;

export interface RecallContextResponse {
  ok: true;
  mode: RecallContextMode;
  question: string;
  filters: {
    files: string[];
    symbols: string[];
  };
  budget: {
    budget_bytes: number;
    used_bytes: number;
    remaining_bytes: number;
    within_budget: boolean;
    truncated: boolean;
    omitted: {
      graph: number;
      source: number;
      capture_summary: number;
    };
  };
  results: RecallResult[];
  warnings: string[];
  source_index: Pick<
    SourceIndexStatus,
    | "chunks_indexed"
    | "files_indexed"
    | "fresh"
    | "indexed"
    | "missing_files"
    | "new_files"
    | "stale_files"
    | "symbols_indexed"
  > & { refreshed: boolean };
}

interface RecallCandidate {
  kind: RecallResult["kind"];
  result: RecallResult;
  rank: number;
}

const DEFAULT_MODE: RecallContextMode = "mixed";
const DEFAULT_LIMIT = 5;
const DEFAULT_BUDGET_BYTES = 4000;
const DEFAULT_MAX_CONTENT_CHARS = 220;
const DEFAULT_REFRESH_INDEX: RecallRefreshMode = "if_missing";
const PROVENANCE_WARNING =
  "Graph results are curated repo memory; source results are rebuildable index hits and must be inspected before writeback.";
const CAPTURE_SUMMARY_WARNING =
  "Capture summary results are rebuildable session evidence; promote only durable source-anchored findings through emit_node or link.";
const CAPTURE_SUMMARY_UNAVAILABLE_WARNING =
  "Capture summary recall unavailable:";
const BUDGET_WARNING =
  "Recall results were omitted to stay within the configured byte budget.";
const EMPTY_WARNING =
  "No recall hits were found in graph memory or the source index.";

export async function buildRecallContext(
  repoRoot: string,
  question: string,
  options: RecallContextOptions = {},
): Promise<RecallContextResponse> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("question must not be empty");
  }

  const mode = options.mode ?? DEFAULT_MODE;
  const limit = clampPositiveInteger(options.limit, DEFAULT_LIMIT);
  const budgetBytes = clampPositiveInteger(
    options.budgetBytes,
    DEFAULT_BUDGET_BYTES,
  );
  const maxContentChars = clampPositiveInteger(
    options.maxContentChars,
    DEFAULT_MAX_CONTENT_CHARS,
  );
  const refreshIndex = options.refreshIndex ?? DEFAULT_REFRESH_INDEX;
  const files = cleanList(options.files);
  const symbols = cleanList(options.symbols);
  const recallQuery = enrichQuery(trimmedQuestion, files, symbols);
  const warnings: string[] = [];

  const graph =
    mode === "source"
      ? emptyGraphResult()
      : await rankedGraphRecall(repoRoot, recallQuery, Math.max(limit * 2, 8));
  if (graph.result.nodes.length > 0) {
    warnings.push(PROVENANCE_WARNING);
  }
  if (graph.staleness.stale_sources.length > 0) {
    warnings.push(
      "Some graph recall anchors are stale; inspect source files before relying on them.",
    );
  }
  const memoryQuality = summarizeGraphMemoryQuality(graph.result);
  if (memoryQuality.low_trust_node_ids.length > 0) {
    warnings.push(
      "Some graph recall results are low-trust; prefer fresh, source-confirmed memory.",
    );
  }

  const source =
    mode === "graph"
      ? await sourceStatusOnly(repoRoot, refreshIndex, warnings)
      : await sourceRecall(repoRoot, recallQuery, {
          limit: Math.max(limit * 2, 8),
          maxContentChars,
          refreshIndex,
          warnings,
        });
  if (source.search?.ok && source.search.results.length > 0) {
    if (!warnings.includes(PROVENANCE_WARNING)) {
      warnings.push(PROVENANCE_WARNING);
    }
    warnings.push(...(source.search.warnings ?? []));
  }

  const graphCandidates = graph.result.nodes
    .filter((node) => matchesNodeFilters(node, files, symbols))
    .map((node) => graphCandidate(node, graph.result, maxContentChars));
  const sourceResults = source.search?.ok ? source.search.results : [];
  const sourceCandidates = sourceResults
    .filter((result) => matchesFileFilters(result.file_path, files))
    .map((result, index) => sourceCandidate(result, index, maxContentChars));
  const captureCandidates =
    options.includeCaptureSummary && mode === "mixed"
      ? await captureSummaryRecall(repoRoot, recallQuery, {
          files,
          symbols,
          maxContentChars,
          warnings,
        })
      : [];
  const candidates = selectCandidates(
    mode,
    graphCandidates,
    sourceCandidates,
    captureCandidates,
    limit,
  );

  if (candidates.length === 0) {
    warnings.push(EMPTY_WARNING);
  }

  const response = fitBudget({
    mode,
    question: trimmedQuestion,
    files,
    symbols,
    budgetBytes,
    candidates,
    totalGraphCandidates: graphCandidates.length,
    totalSourceCandidates: sourceCandidates.length,
    totalCaptureCandidates: captureCandidates.length,
    warnings,
    sourceStatus: source.status,
    refreshed: source.refreshed,
  });

  return response;
}

async function rankedGraphRecall(
  repoRoot: string,
  question: string,
  limit: number,
): Promise<{ result: QueryResult; staleness: StalenessReport }> {
  const store = await GraphStore.load(repoRoot);
  const candidates = store.query(question, Math.max(limit * 2, limit + 5));
  const candidateStaleness = await checkSourceStaleness(
    repoRoot,
    candidates.nodes,
  );
  const result = rankGraphResultByQuality(candidates, candidateStaleness, {
    limit,
    sourceChecksEnabled: true,
  });
  return {
    result,
    staleness: filterStalenessReportForNodes(
      candidateStaleness,
      result.nodes,
      true,
    ),
  };
}

function emptyGraphResult(): { result: QueryResult; staleness: StalenessReport } {
  return {
    result: { nodes: [], edges: [], matches: [] },
    staleness: {
      checked_sources: 0,
      stale_sources: [],
      range_fresh_sources: [],
    },
  };
}

async function sourceStatusOnly(
  repoRoot: string,
  refreshIndex: RecallRefreshMode,
  warnings: string[],
): Promise<{
  status: SourceIndexStatus;
  refreshed: boolean;
  search: SourceSearchResponse | null;
}> {
  const { status, refreshed } = await maybeRefreshSourceIndex(
    repoRoot,
    refreshIndex,
    warnings,
  );
  return { status, refreshed, search: null };
}

async function sourceRecall(
  repoRoot: string,
  question: string,
  options: {
    limit: number;
    maxContentChars: number;
    refreshIndex: RecallRefreshMode;
    warnings: string[];
  },
): Promise<{
  status: SourceIndexStatus;
  refreshed: boolean;
  search: SourceSearchResponse | null;
}> {
  const { status, refreshed } = await maybeRefreshSourceIndex(
    repoRoot,
    options.refreshIndex,
    options.warnings,
  );
  if (!status.indexed || !status.fresh) {
    return { status, refreshed, search: null };
  }

  let sourceIndex: SourceIndex | undefined;
  try {
    sourceIndex = (await loadSourceIndex(repoRoot)) ?? undefined;
  } catch (err) {
    const search: SourceSearchResponse = {
      ok: false,
      query: question,
      index_updated_at: status.updated_at,
      search_time_ms: 0,
      total_results: 0,
      results: [],
      error: {
        code: "INDEX_INVALID",
        message: String(err),
      },
    };
    options.warnings.push(
      `Source search failed: ${search.error?.message ?? String(err)}`,
    );
    return { status, refreshed, search };
  }

  const search = await searchSourceIndex(repoRoot, question, {
    limit: options.limit,
    maxContentChars: options.maxContentChars,
    sourceIndex,
  });
  if (!search.ok && search.error) {
    options.warnings.push(`Source search failed: ${search.error.message}`);
  }
  return { status, refreshed, search };
}

async function maybeRefreshSourceIndex(
  repoRoot: string,
  refreshIndex: RecallRefreshMode,
  warnings: string[],
): Promise<{ status: SourceIndexStatus; refreshed: boolean }> {
  let status = await getSourceIndexStatus(repoRoot);
  let refreshed = false;
  const shouldRefresh =
    refreshIndex === "if_stale"
      ? !status.indexed || !status.fresh
      : refreshIndex === "if_missing" && !status.indexed;

  if (shouldRefresh) {
    try {
      await scanSourceIndex(repoRoot);
      refreshed = true;
      status = await getSourceIndexStatus(repoRoot);
    } catch (err) {
      warnings.push(`Source index refresh failed: ${String(err)}`);
    }
  }

  if (!status.indexed) {
    warnings.push(
      "Source index is missing; run codemap scan or use refresh_index if_missing before relying on source recall.",
    );
  } else if (!status.fresh) {
    warnings.push(
      "Source index is stale; use refresh_index if_stale before relying on source recall.",
    );
  }

  return { status, refreshed };
}

function graphCandidate(
  node: Node,
  graphResult: QueryResult,
  maxContentChars: number,
): RecallCandidate {
  const match = graphResult.matches.find((entry) => entry.node_id === node.id);
  return {
    kind: "graph",
    rank: match?.ranking_score ?? match?.score ?? 0,
    result: {
      kind: "graph",
      provenance: "curated_graph",
      id: node.id,
      node_kind: node.kind,
      name: node.name,
      summary: truncateText(node.summary, maxContentChars),
      score: match?.score,
      ranking_score: match?.ranking_score,
      trust: match?.quality?.trust,
      freshness: match?.quality?.freshness,
      match_reasons: (match?.match_reasons ?? [])
        .slice(0, 3)
        .map((reason) => `${reason.field}:${reason.value}`),
      quality_reasons: (match?.quality?.reasons ?? []).slice(0, 3),
      anchors: node.sources.slice(0, 3).map((source) => ({
        file_path: source.file_path,
        line_range: source.line_range,
      })),
    },
  };
}

function sourceCandidate(
  result: SourceSearchResult,
  index: number,
  maxContentChars: number,
): RecallCandidate {
  return {
    kind: "source",
    rank: result.score - index / 1000,
    result: {
      kind: "source",
      provenance: "rebuildable_source_index",
      file_path: result.file_path,
      line_range: [result.start_line, result.end_line],
      chunk_type: result.chunk_type,
      score: result.score,
      snippet: truncateText(result.content, maxContentChars),
      symbols: result.symbols.slice(0, 3).map((symbol) => symbol.name),
      match_reasons: result.match_reasons
        .slice(0, 3)
        .map((reason) => `${reason.field}:${reason.value}`),
      anchors: [
        {
          file_path: result.file_path,
          line_range: [result.start_line, result.end_line],
        },
      ],
    },
  };
}

async function captureSummaryRecall(
  repoRoot: string,
  question: string,
  options: {
    files: string[];
    symbols: string[];
    maxContentChars: number;
    warnings: string[];
  },
): Promise<RecallCandidate[]> {
  let summaries: Awaited<ReturnType<typeof buildCaptureSummaries>>;
  try {
    summaries = await buildCaptureSummaries(repoRoot, { write: false });
  } catch (err) {
    options.warnings.push(
      `${CAPTURE_SUMMARY_UNAVAILABLE_WARNING} ${errorMessage(err)}`,
    );
    return [];
  }
  const candidates: RecallCandidate[] = [];
  if (summaries.source.event_count === 0) return candidates;

  const profileCandidate = captureProfileCandidate(
    summaries.profile,
    question,
    options,
  );
  if (profileCandidate) candidates.push(profileCandidate);

  for (const session of summaries.sessions) {
    const candidate = captureSessionCandidate(session, question, options);
    if (candidate) candidates.push(candidate);
  }

  if (candidates.length > 0) {
    options.warnings.push(CAPTURE_SUMMARY_WARNING);
  }

  return candidates.sort((a, b) => b.rank - a.rank);
}

function captureProfileCandidate(
  profile: CaptureProfile,
  question: string,
  options: {
    files: string[];
    symbols: string[];
    maxContentChars: number;
  },
): RecallCandidate | null {
  const files = profile.recurring_files.map((file) => file.file_path);
  if (!matchesCaptureFilters(files, options.files)) return null;
  const haystack = [
    "project capture profile",
    ...profile.active_areas.map((area) => area.area),
    ...files,
    ...profile.recent_decisions.map((decision) => `${decision.name} ${decision.summary}`),
    ...profile.unresolved_writeback_opportunities.flatMap((entry) => entry.reasons),
  ].join(" ");
  const match = scoreText(question, haystack, options.symbols);
  if (!matchesSymbolFilters(haystack, options.symbols)) return null;
  if (match.score === 0 && options.files.length === 0 && options.symbols.length === 0) {
    return null;
  }
  const summaryParts = [
    profile.active_areas.length > 0
      ? `active areas: ${profile.active_areas.map((area) => area.area).slice(0, 4).join(", ")}`
      : "no active areas",
    profile.recurring_files.length > 0
      ? `recurring files: ${files.slice(0, 4).join(", ")}`
      : "no recurring files",
    profile.unresolved_writeback_opportunities.length > 0
      ? `${profile.unresolved_writeback_opportunities.length} unresolved writeback opportunity(s)`
      : "no unresolved writeback opportunities",
  ];
  return {
    kind: "capture_summary",
    rank: match.score + profile.source.event_count / 100,
    result: {
      kind: "capture_summary",
      provenance: "rebuildable_capture_summary",
      scope: "profile",
      title: "Project capture profile",
      summary: truncateText(summaryParts.join("; "), options.maxContentChars),
      event_count: profile.source.event_count,
      files: files.slice(0, 6),
      stale_anchors: 0,
      match_reasons: match.reasons,
      anchors: profile.recurring_files.slice(0, 3).map((file) => ({
        file_path: file.file_path,
        line_range: [1, 1],
      })),
      warnings: profile.warnings.slice(0, 3),
    },
  };
}

function captureSessionCandidate(
  session: CaptureSessionSummaryRecord,
  question: string,
  options: {
    files: string[];
    symbols: string[];
    maxContentChars: number;
  },
): RecallCandidate | null {
  const files = session.files.map((file) => file.file_path);
  if (!matchesCaptureFilters(files, options.files)) return null;
  const haystack = [
    session.session_id,
    ...files,
    ...session.prompt_samples,
    ...session.codemap_calls,
    ...session.writeback_suggestions,
    ...session.graph_writes,
  ].join(" ");
  const match = scoreText(question, haystack, options.symbols);
  if (!matchesSymbolFilters(haystack, options.symbols)) return null;
  if (match.score === 0 && options.files.length === 0 && options.symbols.length === 0) {
    return null;
  }
  const changedFiles = session.files
    .filter((file) => file.modified_events > 0)
    .map((file) => file.file_path);
  const summary = [
    `${session.total_events} captured event(s)`,
    changedFiles.length > 0
      ? `modified ${changedFiles.slice(0, 3).join(", ")}`
      : undefined,
    session.prompt_samples[0],
  ]
    .filter(Boolean)
    .join("; ");
  return {
    kind: "capture_summary",
    rank: match.score + session.total_events / 100,
    result: {
      kind: "capture_summary",
      provenance: "rebuildable_capture_summary",
      scope: "session",
      session_id: session.session_id,
      title: `Capture session ${session.session_id}`,
      summary: truncateText(summary, options.maxContentChars),
      event_count: session.total_events,
      files: files.slice(0, 6),
      stale_anchors: session.stale_anchors.length,
      match_reasons: match.reasons,
      anchors: session.files.slice(0, 3).map((file) => ({
        file_path: file.file_path,
        line_range: file.line_ranges[0] ?? [1, 1],
      })),
      warnings: session.warnings.slice(0, 3),
    },
  };
}

function selectCandidates(
  mode: RecallContextMode,
  graphCandidates: RecallCandidate[],
  sourceCandidates: RecallCandidate[],
  captureCandidates: RecallCandidate[],
  limit: number,
): RecallCandidate[] {
  if (mode === "graph") return graphCandidates.slice(0, limit);
  if (mode === "source") return sourceCandidates.slice(0, limit);

  const selected: RecallCandidate[] = [];
  const maxLength = Math.max(
    graphCandidates.length,
    captureCandidates.length,
    sourceCandidates.length,
  );
  for (let index = 0; index < maxLength && selected.length < limit; index += 1) {
    const graph = graphCandidates[index];
    if (graph) selected.push(graph);
    if (selected.length >= limit) break;
    const capture = captureCandidates[index];
    if (capture) selected.push(capture);
    if (selected.length >= limit) break;
    const source = sourceCandidates[index];
    if (source) selected.push(source);
  }
  return selected.slice(0, limit);
}

function fitBudget(input: {
  mode: RecallContextMode;
  question: string;
  files: string[];
  symbols: string[];
  budgetBytes: number;
  candidates: RecallCandidate[];
  totalGraphCandidates: number;
  totalSourceCandidates: number;
  totalCaptureCandidates: number;
  warnings: string[];
  sourceStatus: SourceIndexStatus;
  refreshed: boolean;
}): RecallContextResponse {
  const results: RecallResult[] = [];
  let omittedForBudget = false;

  for (const candidate of input.candidates) {
    const tentativeResults = [...results, candidate.result];
    const omitted = omittedCounts({
      results: tentativeResults,
      totalGraphCandidates: input.totalGraphCandidates,
      totalSourceCandidates: input.totalSourceCandidates,
      totalCaptureCandidates: input.totalCaptureCandidates,
    });
    const warnings = buildBudgetWarnings(input.warnings, false);
    const tentative = finalizeBudget(
      baseResponse({
        ...input,
        results: tentativeResults,
        warnings,
        omitted,
      }),
    );
    if (tentative.budget.used_bytes <= input.budgetBytes) {
      results.push(candidate.result);
    } else {
      omittedForBudget = true;
    }
  }

  const omitted = omittedCounts({
    results,
    totalGraphCandidates: input.totalGraphCandidates,
    totalSourceCandidates: input.totalSourceCandidates,
    totalCaptureCandidates: input.totalCaptureCandidates,
  });
  const warnings = buildBudgetWarnings(input.warnings, omittedForBudget);
  return finalizeBudget(
    baseResponse({
      ...input,
      results,
      warnings,
      omitted,
    }),
  );
}

function baseResponse(input: {
  mode: RecallContextMode;
  question: string;
  files: string[];
  symbols: string[];
  budgetBytes: number;
  results: RecallResult[];
  omitted: { graph: number; source: number; capture_summary: number };
  warnings: string[];
  sourceStatus: SourceIndexStatus;
  refreshed: boolean;
}): RecallContextResponse {
  return {
    ok: true,
    mode: input.mode,
    question: input.question,
    filters: {
      files: input.files,
      symbols: input.symbols,
    },
    budget: {
      budget_bytes: input.budgetBytes,
      used_bytes: 0,
      remaining_bytes: input.budgetBytes,
      within_budget: true,
      truncated:
        input.omitted.graph > 0 ||
        input.omitted.source > 0 ||
        input.omitted.capture_summary > 0,
      omitted: input.omitted,
    },
    results: input.results,
    warnings: dedupe(input.warnings),
    source_index: {
      indexed: input.sourceStatus.indexed,
      fresh: input.sourceStatus.fresh,
      refreshed: input.refreshed,
      files_indexed: input.sourceStatus.files_indexed,
      chunks_indexed: input.sourceStatus.chunks_indexed,
      symbols_indexed: input.sourceStatus.symbols_indexed,
      stale_files: input.sourceStatus.stale_files,
      missing_files: input.sourceStatus.missing_files,
      new_files: input.sourceStatus.new_files,
    },
  };
}

function finalizeBudget(response: RecallContextResponse): RecallContextResponse {
  let next = response;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const used = responseBytes(next);
    const updated: RecallContextResponse = {
      ...next,
      budget: {
        ...next.budget,
        used_bytes: used,
        remaining_bytes: Math.max(0, next.budget.budget_bytes - used),
        within_budget: used <= next.budget.budget_bytes,
      },
    };
    if (responseBytes(updated) === used) {
      return updated;
    }
    next = updated;
  }
  const used = responseBytes(next);
  return {
    ...next,
    budget: {
      ...next.budget,
      used_bytes: used,
      remaining_bytes: Math.max(0, next.budget.budget_bytes - used),
      within_budget: used <= next.budget.budget_bytes,
    },
  };
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function omittedCounts(input: {
  results: RecallResult[];
  totalGraphCandidates: number;
  totalSourceCandidates: number;
  totalCaptureCandidates: number;
}): { graph: number; source: number; capture_summary: number } {
  const graph = input.results.filter((result) => result.kind === "graph").length;
  const source = input.results.filter((result) => result.kind === "source")
    .length;
  const capture = input.results.filter(
    (result) => result.kind === "capture_summary",
  ).length;
  return {
    graph: Math.max(0, input.totalGraphCandidates - graph),
    source: Math.max(0, input.totalSourceCandidates - source),
    capture_summary: Math.max(0, input.totalCaptureCandidates - capture),
  };
}

function buildBudgetWarnings(
  warnings: string[],
  omittedForBudget: boolean,
): string[] {
  return omittedForBudget ? [...warnings, BUDGET_WARNING] : warnings;
}

function enrichQuery(
  question: string,
  files: string[],
  symbols: string[],
): string {
  const parts = [question];
  if (files.length > 0) parts.push(...files);
  if (symbols.length > 0) parts.push(...symbols);
  return parts.join(" ");
}

function matchesNodeFilters(
  node: Node,
  files: string[],
  symbols: string[],
): boolean {
  if (
    files.length > 0 &&
    !node.sources.some((source) => matchesFileFilters(source.file_path, files))
  ) {
    return false;
  }
  if (symbols.length === 0) return true;
  const haystack = [
    node.id,
    node.name,
    node.summary,
    ...node.aliases,
    ...node.tags,
  ]
    .join(" ")
    .toLowerCase();
  return symbols.some((symbol) => haystack.includes(symbol.toLowerCase()));
}

function matchesFileFilters(filePath: string, files: string[]): boolean {
  if (files.length === 0) return true;
  return files.some((file) => filePath === file || filePath.endsWith(`/${file}`));
}

function matchesCaptureFilters(candidateFiles: string[], files: string[]): boolean {
  if (files.length === 0) return true;
  return candidateFiles.some((candidate) => matchesFileFilters(candidate, files));
}

function matchesSymbolFilters(text: string, symbols: string[]): boolean {
  if (symbols.length === 0) return true;
  const haystack = text.toLowerCase();
  return symbols.some((symbol) => haystack.includes(symbol.toLowerCase()));
}

function scoreText(
  question: string,
  text: string,
  symbols: string[],
): { score: number; reasons: string[] } {
  const haystack = text.toLowerCase();
  const tokens = [...question.toLowerCase().split(/\s+/), ...symbols]
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 1);
  let score = 0;
  const reasons: string[] = [];
  for (const token of new Set(tokens)) {
    if (!haystack.includes(token)) continue;
    score += 1;
    if (reasons.length < 3) reasons.push(`text:${token}`);
  }
  return { score, reasons };
}

function cleanList(values: string[] | undefined): string[] {
  return dedupe((values ?? []).map((value) => value.trim()).filter(Boolean));
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 16)).trimEnd()} ... truncated`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clampPositiveInteger(
  value: number | undefined,
  defaultValue: number,
): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : defaultValue;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
