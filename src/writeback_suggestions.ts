import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import {
	type CaptureEventKind,
	summarizeCaptureSession,
} from "./capture_events.js";
import { GraphStore, type QueryResult } from "./graph.js";
import {
	filterStalenessReportForNodes,
	rankGraphResultByQuality,
} from "./graph_quality.js";
import { checkSourceStaleness } from "./staleness.js";
import type { SourceRef } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_LIMIT = 6;
const MAX_SOURCE_CANDIDATES = 5;

export type WritebackSuggestionKind =
	| "decision"
	| "gotcha"
	| "invariant"
	| "link";

export type WritebackFileReason =
	| "git_changed"
	| "inspected"
	| "modified"
	| "stale_graph_source"
	| "captured_inspected"
	| "captured_modified"
	| "captured_recall_hit";

export interface WritebackFileCandidate extends SourceRef {
	reasons: WritebackFileReason[];
}

export interface WritebackSuggestion {
	id: string;
	kind: WritebackSuggestionKind;
	title: string;
	rationale: string;
	source_candidates: WritebackFileCandidate[];
	related_node_ids: string[];
	confidence: number;
	next_action: string;
}

export interface WritebackSuggestionGroups {
	decisions: WritebackSuggestion[];
	invariants: WritebackSuggestion[];
	gotchas: WritebackSuggestion[];
	links: WritebackSuggestion[];
}

export interface WritebackSuggestionOptions {
	activeTopic?: string | null;
	inspectedFiles?: string[];
	modifiedFiles?: string[];
	workSummary?: string;
	includeGit?: boolean;
	captureSessionId?: string;
	includeLatestCaptureSession?: boolean;
	captureLimit?: number;
	limit?: number;
}

export interface WritebackCaptureEvidence {
	requested: string;
	session_id?: string;
	total_events: number;
	used_events: number;
	captured_files: string[];
}

export interface WritebackSuggestionResponse {
	ok: true;
	active_topic: string | null;
	evidence: {
		inspected_files: string[];
		modified_files: string[];
		git_changed_files: string[];
		capture_session: WritebackCaptureEvidence | null;
		work_summary: string | null;
		related_node_ids: string[];
		stale_graph_node_ids: string[];
	};
	suggestions: WritebackSuggestionGroups;
	total_suggestions: number;
	warnings: string[];
	next_steps: string[];
}

interface FileAccumulator {
	file_path: string;
	reasons: Set<WritebackFileReason>;
}

type RepoPathResolution =
	| { ok: true; absolutePath: string; filePath: string }
	| {
			ok: false;
			reason: "empty" | "excluded" | "outside";
			displayPath: string;
	  };

interface BuildContext {
	activeTopic: string | null;
	workSummary: string;
	files: WritebackFileCandidate[];
	relatedNodeIds: string[];
	staleGraphNodeIds: string[];
	limit: number;
}

function emptyQueryResult(): QueryResult {
	return { nodes: [], edges: [], matches: [] };
}

export async function buildWritebackSuggestions(
	repoRoot: string,
	options: WritebackSuggestionOptions = {},
): Promise<WritebackSuggestionResponse> {
	const warnings: string[] = [];
	const activeTopic = normalizeText(options.activeTopic ?? "");
	const workSummary = normalizeText(options.workSummary ?? "");
	const limit = clampLimit(options.limit ?? DEFAULT_LIMIT);

	const fileReasons = new Map<string, FileAccumulator>();
	addInputFiles(
		repoRoot,
		fileReasons,
		options.inspectedFiles ?? [],
		"inspected",
	);
	addInputFiles(repoRoot, fileReasons, options.modifiedFiles ?? [], "modified");

	let gitChangedFiles: string[] = [];
	if (options.includeGit) {
		const gitResult = await gitChangedFilePaths(repoRoot);
		gitChangedFiles = gitResult.files;
		warnings.push(...gitResult.warnings);
		addInputFiles(repoRoot, fileReasons, gitChangedFiles, "git_changed");
	}

	const captureEvidence = await loadCaptureEvidence(
		repoRoot,
		options,
		fileReasons,
	);

	const query = [activeTopic, workSummary].filter(Boolean).join(" ").trim();
	const store = await GraphStore.load(repoRoot);
	const relatedCandidates = query ? store.query(query, 15) : emptyQueryResult();
	const staleness = await checkSourceStaleness(
		repoRoot,
		relatedCandidates.nodes,
	);
	const related = rankGraphResultByQuality(relatedCandidates, staleness, {
		limit: 5,
	});
	const relatedNodeIds = related.nodes.map((node) => node.id);
	const relatedStaleness = filterStalenessReportForNodes(
		staleness,
		related.nodes,
	);
	const staleGraphNodeIds = unique(
		relatedStaleness.stale_sources.map((source) => source.node_id),
	);
	for (const staleSource of relatedStaleness.stale_sources) {
		addFileReason(
			repoRoot,
			fileReasons,
			staleSource.file_path,
			"stale_graph_source",
		);
	}

	const files = await validateFileCandidates(repoRoot, fileReasons, warnings);
	const suggestions = buildSuggestions({
		activeTopic: activeTopic || null,
		workSummary,
		files,
		relatedNodeIds,
		staleGraphNodeIds,
		limit,
	});
	const totalSuggestions = countSuggestions(suggestions);

	if (totalSuggestions === 0 && files.length === 0) {
		warnings.push(
			"No repo-local file evidence was provided or found, so no writeback suggestions were generated.",
		);
	}

	return {
		ok: true,
		active_topic: activeTopic || null,
		evidence: {
			inspected_files: filesWithReason(files, "inspected"),
			modified_files: filesWithReason(files, "modified"),
			git_changed_files: filesWithReason(files, "git_changed"),
			capture_session: captureEvidence,
			work_summary: workSummary || null,
			related_node_ids: relatedNodeIds,
			stale_graph_node_ids: staleGraphNodeIds,
		},
		suggestions,
		total_suggestions: totalSuggestions,
		warnings,
		next_steps: nextSteps(totalSuggestions),
	};
}

async function loadCaptureEvidence(
	repoRoot: string,
	options: WritebackSuggestionOptions,
	fileReasons: Map<string, FileAccumulator>,
): Promise<WritebackCaptureEvidence | null> {
	if (!options.captureSessionId && !options.includeLatestCaptureSession) {
		return null;
	}
	const requested = options.captureSessionId ?? "latest";
	const summary = await summarizeCaptureSession(repoRoot, {
		sessionId: options.captureSessionId,
		limit: clampCaptureLimit(options.captureLimit),
	});
	const capturedFiles = new Set<string>();
	let usedEvents = 0;

	for (const event of summary.events) {
		const reason = captureReasonForKind(event.kind);
		if (!reason || event.anchors.length === 0) continue;
		let usedEvent = false;
		for (const anchor of event.anchors) {
			const key = evidenceFileKey(repoRoot, anchor.file_path);
			if (!key || shouldIgnoreFile(key)) continue;
			addFileReason(repoRoot, fileReasons, key, reason);
			capturedFiles.add(key);
			usedEvent = true;
		}
		if (usedEvent) usedEvents += 1;
	}

	return {
		requested,
		session_id: summary.session_id,
		total_events: summary.total_events,
		used_events: usedEvents,
		captured_files: [...capturedFiles].sort(),
	};
}

function captureReasonForKind(
	kind: CaptureEventKind,
): WritebackFileReason | null {
	if (kind === "file_inspected") return "captured_inspected";
	if (kind === "file_modified") return "captured_modified";
	if (kind === "recall_hit") return "captured_recall_hit";
	return null;
}

function buildSuggestions(input: BuildContext): WritebackSuggestionGroups {
	const suggestions: WritebackSuggestionGroups = {
		decisions: [],
		invariants: [],
		gotchas: [],
		links: [],
	};
	const changedFiles = input.files.filter(
		(file) =>
			file.reasons.includes("modified") ||
			file.reasons.includes("git_changed") ||
			file.reasons.includes("captured_modified"),
	);
	const inspectedFiles = input.files.filter(
		(file) =>
			file.reasons.includes("inspected") ||
			file.reasons.includes("captured_inspected") ||
			file.reasons.includes("captured_recall_hit"),
	);
	const sourceCandidates = pickSourceCandidates(
		changedFiles.length > 0
			? uniqueFileCandidates([...changedFiles, ...inspectedFiles])
			: input.files,
	);
	const text = `${input.activeTopic ?? ""} ${input.workSummary}`.toLowerCase();

	if (
		sourceCandidates.length > 0 &&
		shouldSuggestDecision(text, changedFiles)
	) {
		suggestions.decisions.push(
			suggestion({
				id: "capture-decision",
				kind: "decision",
				title: "Capture the implementation decision",
				rationale:
					"Changed repo files plus the task summary may contain a durable choice future agents should not re-derive.",
				sourceCandidates,
				relatedNodeIds: input.relatedNodeIds,
				confidence: changedFiles.length > 0 ? 0.74 : 0.58,
			}),
		);
	}

	if (
		sourceCandidates.length > 0 &&
		shouldSuggestInvariant(text, input.files, inspectedFiles)
	) {
		suggestions.invariants.push(
			suggestion({
				id: "capture-invariant",
				kind: "invariant",
				title: "Capture the behavior invariant",
				rationale:
					"The evidence points at behavior, tests, contracts, or inspected source that may encode a must-hold rule.",
				sourceCandidates,
				relatedNodeIds: input.relatedNodeIds,
				confidence: inspectedFiles.length > 0 ? 0.72 : 0.64,
			}),
		);
	}

	if (
		sourceCandidates.length > 0 &&
		(shouldSuggestGotcha(text) || input.staleGraphNodeIds.length > 0)
	) {
		suggestions.gotchas.push(
			suggestion({
				id: "capture-gotcha",
				kind: "gotcha",
				title: "Capture the gotcha or review finding",
				rationale:
					"The work mentions a fix, failure mode, stale memory, or review concern that could surprise the next agent.",
				sourceCandidates,
				relatedNodeIds: input.relatedNodeIds,
				confidence: input.staleGraphNodeIds.length > 0 ? 0.76 : 0.68,
			}),
		);
	}

	if (input.relatedNodeIds.length >= 2 && input.files.length > 0) {
		suggestions.links.push(
			suggestion({
				id: "capture-relationship",
				kind: "link",
				title: "Consider linking related graph memories",
				rationale:
					"The task matched multiple existing graph nodes; if their relationship was confirmed from source, a typed link may be more useful than another node.",
				sourceCandidates: pickSourceCandidates(input.files),
				relatedNodeIds: input.relatedNodeIds.slice(0, 5),
				confidence: 0.62,
			}),
		);
	}

	return trimSuggestionGroups(suggestions, input.limit);
}

function suggestion(input: {
	id: string;
	kind: WritebackSuggestionKind;
	title: string;
	rationale: string;
	sourceCandidates: WritebackFileCandidate[];
	relatedNodeIds: string[];
	confidence: number;
}): WritebackSuggestion {
	return {
		id: input.id,
		kind: input.kind,
		title: input.title,
		rationale: input.rationale,
		source_candidates: input.sourceCandidates,
		related_node_ids: input.relatedNodeIds.slice(0, 5),
		confidence: input.confidence,
		next_action:
			input.kind === "link"
				? "Inspect the related nodes and source files, then call link only for a confirmed relationship."
				: `Inspect the source candidates, then call emit_node with kind "${input.kind}" only if the finding is durable repo-local knowledge.`,
	};
}

function shouldSuggestDecision(
	text: string,
	changedFiles: WritebackFileCandidate[],
): boolean {
	if (changedFiles.length >= 2) return true;
	if (
		/\b(decid\w*|choice|approach|design|architecture|tradeoff|implement\w*|refactor\w*|review)\b/.test(
			text,
		)
	) {
		return true;
	}
	return changedFiles.some((file) =>
		/(^|\/)(README|ROADMAP|TECH_SPEC|V1_SPEC|package\.json|tasks\/)/.test(
			file.file_path,
		),
	);
}

function shouldSuggestInvariant(
	text: string,
	files: WritebackFileCandidate[],
	inspectedFiles: WritebackFileCandidate[],
): boolean {
	if (
		/\b(invariant|contract|must|guarantee|behavior|reject|require|should|test)\b/.test(
			text,
		)
	) {
		return true;
	}
	if (
		inspectedFiles.length > 0 &&
		files.some((file) => isSourceFile(file.file_path))
	) {
		return true;
	}
	return files.some(
		(file) =>
			/(^|\/)(test|tests|__tests__)\//.test(file.file_path) ||
			/\.(test|spec)\.[cm]?[jt]sx?$/.test(file.file_path),
	);
}

function shouldSuggestGotcha(text: string): boolean {
	return /\b(bug|fix\w*|failure|fail\w*|stale|warning|gotcha|regression|edge case|review|misleading|silent)\b/.test(
		text,
	);
}

function trimSuggestionGroups(
	suggestions: WritebackSuggestionGroups,
	limit: number,
): WritebackSuggestionGroups {
	const ordered: Array<
		readonly [keyof WritebackSuggestionGroups, WritebackSuggestion]
	> = [
		...suggestions.gotchas.map((entry) => ["gotchas", entry] as const),
		...suggestions.decisions.map((entry) => ["decisions", entry] as const),
		...suggestions.invariants.map((entry) => ["invariants", entry] as const),
		...suggestions.links.map((entry) => ["links", entry] as const),
	];
	const trimmed: WritebackSuggestionGroups = {
		decisions: [],
		invariants: [],
		gotchas: [],
		links: [],
	};
	for (const [group, entry] of ordered.slice(0, limit)) {
		trimmed[group].push(entry);
	}
	return trimmed;
}

async function validateFileCandidates(
	repoRoot: string,
	fileReasons: Map<string, FileAccumulator>,
	warnings: string[],
): Promise<WritebackFileCandidate[]> {
	const candidates: WritebackFileCandidate[] = [];
	for (const entry of fileReasons.values()) {
		const resolved = resolveRepoPath(repoRoot, entry.file_path);
		if (!resolved.ok) {
			if (resolved.reason === "excluded") {
				warnings.push(`Ignored excluded path: ${resolved.displayPath}`);
			} else if (resolved.reason === "outside") {
				warnings.push(`Ignored non-repo path: ${entry.file_path}`);
			}
			continue;
		}
		try {
			const stat = await fs.stat(resolved.absolutePath);
			if (!stat.isFile()) {
				warnings.push(`Ignored non-file path: ${entry.file_path}`);
				continue;
			}
			const content = await fs.readFile(resolved.absolutePath);
			const lineCount = countLines(content);
			candidates.push({
				file_path: resolved.filePath,
				line_range: [1, Math.max(1, Math.min(lineCount, 80))],
				content_hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
				reasons: [...entry.reasons].sort(),
			});
		} catch (err) {
			warnings.push(
				`Ignored missing or unreadable file: ${entry.file_path} (${String(err)})`,
			);
		}
	}
	return candidates.sort((a, b) => a.file_path.localeCompare(b.file_path));
}

function resolveRepoPath(
	repoRoot: string,
	inputPath: string,
): RepoPathResolution {
	const trimmed = inputPath.trim();
	if (!trimmed) {
		return { ok: false, reason: "empty", displayPath: inputPath };
	}
	const repoAbsolute = path.resolve(repoRoot);
	const absolutePath = path.isAbsolute(trimmed)
		? path.resolve(trimmed)
		: path.resolve(repoAbsolute, trimmed);
	const relative = path.relative(repoAbsolute, absolutePath);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		return { ok: false, reason: "outside", displayPath: trimmed };
	}
	const filePath = toPosixPath(relative);
	if (shouldIgnoreFile(filePath)) {
		return { ok: false, reason: "excluded", displayPath: filePath };
	}
	return { ok: true, absolutePath, filePath };
}

async function gitChangedFilePaths(
	repoRoot: string,
): Promise<{ files: string[]; warnings: string[] }> {
	const warnings: string[] = [];
	try {
		await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: repoRoot,
		});
		const status = await execFileAsync(
			"git",
			["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
			{ cwd: repoRoot },
		);
		return {
			files: parsePorcelainStatus(status.stdout),
			warnings,
		};
	} catch (err) {
		warnings.push(`Git changed-file inspection unavailable: ${String(err)}`);
		return { files: [], warnings };
	}
}

function addInputFiles(
	repoRoot: string,
	fileReasons: Map<string, FileAccumulator>,
	files: string[],
	reason: WritebackFileReason,
): void {
	for (const file of files) {
		addFileReason(repoRoot, fileReasons, file, reason);
	}
}

function addFileReason(
	repoRoot: string,
	fileReasons: Map<string, FileAccumulator>,
	file: string,
	reason: WritebackFileReason,
): void {
	const key = evidenceFileKey(repoRoot, file);
	if (!key) return;
	const existing = fileReasons.get(key);
	if (existing) {
		existing.reasons.add(reason);
	} else {
		fileReasons.set(key, { file_path: key, reasons: new Set([reason]) });
	}
}

function evidenceFileKey(repoRoot: string, file: string): string {
	const resolved = resolveRepoPath(repoRoot, file);
	if (resolved.ok) return resolved.filePath;
	if (resolved.reason === "excluded") return resolved.displayPath;
	return toPosixPath(file.trim());
}

function filesWithReason(
	files: WritebackFileCandidate[],
	reason: WritebackFileReason,
): string[] {
	return files
		.filter((file) => file.reasons.includes(reason))
		.map((file) => file.file_path);
}

function pickSourceCandidates(
	files: WritebackFileCandidate[],
): WritebackFileCandidate[] {
	return files.slice(0, MAX_SOURCE_CANDIDATES);
}

function uniqueFileCandidates(
	files: WritebackFileCandidate[],
): WritebackFileCandidate[] {
	const candidates = new Map<string, WritebackFileCandidate>();
	for (const file of files) {
		if (!candidates.has(file.file_path)) {
			candidates.set(file.file_path, file);
		}
	}
	return [...candidates.values()];
}

function countSuggestions(suggestions: WritebackSuggestionGroups): number {
	return (
		suggestions.decisions.length +
		suggestions.invariants.length +
		suggestions.gotchas.length +
		suggestions.links.length
	);
}

function nextSteps(totalSuggestions: number): string[] {
	if (totalSuggestions === 0) {
		return [
			"No writeback prompt is needed yet. If this was a repo task, provide inspected_files or modified_files after inspecting real files.",
		];
	}
	return [
		"Review each suggestion against the actual files before writing graph memory.",
		"Call emit_node only for durable decisions, invariants, or gotchas with real source anchors.",
		"Call link only when a relationship between existing nodes was confirmed from source.",
	];
}

function normalizeText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function countLines(content: Buffer): number {
	if (content.length === 0) return 1;
	const lines = content.toString("utf8").split(/\r?\n/);
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return Math.max(1, lines.length);
}

function clampLimit(limit: number): number {
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.min(20, Math.max(0, Math.floor(limit)));
}

function clampCaptureLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return 200;
	return Math.min(1000, Math.max(0, Math.floor(limit)));
}

function parsePorcelainStatus(value: string): string[] {
	const records = value.split("\0").filter(Boolean);
	const files: string[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length < 4) continue;
		const status = record.slice(0, 2);
		if (status === "!!") continue;
		files.push(record.slice(3));
		if (
			/^[RC]/.test(status.trim()) &&
			index + 1 < records.length &&
			!/^[ MADRCU?!][ MADRCU?!] /.test(records[index + 1])
		) {
			index += 1;
		}
	}
	return unique(files);
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function toPosixPath(value: string): string {
	return value.replaceAll(path.sep, "/").replace(/^\.\//, "");
}

function shouldIgnoreFile(filePath: string): boolean {
	return /(^|\/)(\.git|\.codemap|node_modules|dist|coverage)(\/|$)/.test(
		filePath,
	);
}

function isSourceFile(filePath: string): boolean {
	return /\.[cm]?[jt]sx?$/.test(filePath);
}
