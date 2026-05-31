import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
	type CaptureEvent,
	type CaptureEventKind,
	captureEventPath,
	readCaptureEventRecords,
	redactCaptureText,
} from "./capture_events.js";
import { GraphStore } from "./graph.js";
import { safeRepoPath } from "./staleness.js";
import type { Node } from "./types.js";
import { normalizeRepoPath } from "./util/repo_path.js";

const CAPTURE_SUMMARY_VERSION = 1 as const;
const CAPTURE_INDEX_DIR = ".codemap/index/capture";
const CAPTURE_SESSIONS_FILE = "sessions.json";
const CAPTURE_PROFILE_FILE = "profile.json";
const DEFAULT_RECENT_LIMIT = 8;
const DEFAULT_PROMPT_SAMPLE_LIMIT = 3;

export interface CaptureSummaryOptions {
	sessionId?: string;
	limit?: number;
	exclude?: string[];
	write?: boolean;
	generatedAt?: string;
	events?: CaptureEvent[];
}

export interface CaptureAnchorIssue {
	session_id: string;
	event_id: string;
	file_path: string;
	line_range: [number, number];
	reason: "missing" | "read_error" | "range_out_of_bounds";
}

export interface CaptureSessionFileSummary {
	file_path: string;
	event_count: number;
	inspected_events: number;
	modified_events: number;
	recall_hit_events: number;
	writeback_suggestion_events: number;
	graph_write_events: number;
	line_ranges: Array<[number, number]>;
}

export interface CaptureSessionSummaryRecord {
	session_id: string;
	total_events: number;
	counts_by_kind: Partial<Record<CaptureEventKind, number>>;
	first_event_at?: string;
	last_event_at?: string;
	files: CaptureSessionFileSummary[];
	prompt_samples: string[];
	codemap_calls: string[];
	graph_writes: string[];
	writeback_suggestions: string[];
	stale_anchors: CaptureAnchorIssue[];
	warnings: string[];
}

export interface CaptureAreaSummary {
	area: string;
	event_count: number;
	file_count: number;
	session_ids: string[];
}

export interface CaptureRecurringFile {
	file_path: string;
	event_count: number;
	inspected_events: number;
	modified_events: number;
	recall_hit_events: number;
	session_ids: string[];
}

export interface CaptureRecentDecision {
	id: string;
	name: string;
	summary: string;
	last_verified_at: string;
	source_files: string[];
}

export interface CaptureWritebackOpportunity {
	session_id: string;
	reasons: string[];
	files: string[];
	event_count: number;
	last_event_at?: string;
}

export interface CaptureProfile {
	version: typeof CAPTURE_SUMMARY_VERSION;
	generated_at: string;
	source: {
		events_path: string;
		event_count: number;
		session_count: number;
		first_event_at?: string;
		last_event_at?: string;
	};
	active_areas: CaptureAreaSummary[];
	recurring_files: CaptureRecurringFile[];
	recent_decisions: CaptureRecentDecision[];
	unresolved_writeback_opportunities: CaptureWritebackOpportunity[];
	warnings: string[];
}

export interface CaptureSessionsFile {
	version: typeof CAPTURE_SUMMARY_VERSION;
	generated_at: string;
	source: CaptureProfile["source"];
	sessions: CaptureSessionSummaryRecord[];
}

export interface CaptureSummaryResponse {
	ok: true;
	session_id: string | null;
	paths: {
		events: string;
		sessions: string;
		profile: string;
	};
	source: CaptureProfile["source"];
	sessions: CaptureSessionSummaryRecord[];
	profile: CaptureProfile;
	wrote_files: boolean;
	warnings: string[];
}

interface MutableFileSummary extends CaptureSessionFileSummary {
	lineRangeKeys: Set<string>;
}

export function captureSessionsPath(repoRoot: string): string {
	return path.join(repoRoot, CAPTURE_INDEX_DIR, CAPTURE_SESSIONS_FILE);
}

export function captureProfilePath(repoRoot: string): string {
	return path.join(repoRoot, CAPTURE_INDEX_DIR, CAPTURE_PROFILE_FILE);
}

export async function buildCaptureSummaries(
	repoRoot: string,
	options: CaptureSummaryOptions = {},
): Promise<CaptureSummaryResponse> {
	const generatedAt = options.generatedAt ?? new Date().toISOString();
	const excludes = cleanList(options.exclude);
	const warnings: string[] = [];
	let events: CaptureEvent[];
	if (options.events === undefined) {
		const readResult = await readCaptureEventRecords(repoRoot, {
			sessionId: options.sessionId,
			limit: options.limit,
		});
		events = readResult.events;
		for (const issue of readResult.ignored_events) {
			warnings.push(
				`Invalid capture event at line ${issue.line_number}: ${issue.reason}`,
			);
		}
	} else {
		events = selectSummaryEvents(options.events, options);
	}
	const sessions = await summarizeSessions(repoRoot, events, excludes);
	const source = sourceSummary(repoRoot, events, sessions.length);
	const profile = await buildProfile(repoRoot, sessions, source, generatedAt);
	warnings.push(...profile.warnings);
	for (const session of sessions) warnings.push(...session.warnings);

	const sessionsFile: CaptureSessionsFile = {
		version: CAPTURE_SUMMARY_VERSION,
		generated_at: generatedAt,
		source,
		sessions,
	};

	if (options.write) {
		await writeJsonFile(captureSessionsPath(repoRoot), sessionsFile);
		await writeJsonFile(captureProfilePath(repoRoot), profile);
	}

	return {
		ok: true,
		session_id: options.sessionId ?? null,
		paths: {
			events: captureEventPath(repoRoot),
			sessions: captureSessionsPath(repoRoot),
			profile: captureProfilePath(repoRoot),
		},
		source,
		sessions,
		profile,
		wrote_files: options.write ?? false,
		warnings: [...new Set(warnings)],
	};
}

async function summarizeSessions(
	repoRoot: string,
	events: CaptureEvent[],
	excludes: string[],
): Promise<CaptureSessionSummaryRecord[]> {
	const bySession = new Map<string, CaptureEvent[]>();
	for (const event of events) {
		const sessionEvents = bySession.get(event.session_id) ?? [];
		sessionEvents.push(event);
		bySession.set(event.session_id, sessionEvents);
	}

	const sessions: CaptureSessionSummaryRecord[] = [];
	for (const [sessionId, sessionEvents] of bySession) {
		sessions.push(
			await summarizeOneSession(repoRoot, sessionId, sessionEvents, excludes),
		);
	}

	return sessions.sort((a, b) =>
		(a.first_event_at ?? "").localeCompare(b.first_event_at ?? "") ||
		a.session_id.localeCompare(b.session_id),
	);
}

async function summarizeOneSession(
	repoRoot: string,
	sessionId: string,
	events: CaptureEvent[],
	excludes: string[],
): Promise<CaptureSessionSummaryRecord> {
	const counts: Partial<Record<CaptureEventKind, number>> = {};
	const files = new Map<string, MutableFileSummary>();
	const promptSamples: string[] = [];
	const codemapCalls = new Set<string>();
	const graphWrites = new Set<string>();
	const writebackSuggestions = new Set<string>();
	const warnings: string[] = [];
	const staleAnchors: CaptureAnchorIssue[] = [];

	for (const event of events) {
		counts[event.kind] = (counts[event.kind] ?? 0) + 1;
		captureTextSample(event, promptSamples);
		captureToolName(event, codemapCalls);
		captureGraphWrites(event, graphWrites);
		captureWritebackSuggestion(event, writebackSuggestions);
		const countedFileEvents = new Set<string>();

		for (const anchor of event.anchors) {
			const filePath = normalizeRepoPath(anchor.file_path);
			if (shouldExcludePath(filePath, excludes)) {
				warnings.push(`Excluded captured path from summaries: ${filePath}`);
				continue;
			}
			const summary = getFileSummary(files, filePath);
			if (!countedFileEvents.has(filePath)) {
				countedFileEvents.add(filePath);
				incrementFileEventSummary(summary, event.kind);
			}
			const rangeKey = `${anchor.line_range[0]}:${anchor.line_range[1]}`;
			if (!summary.lineRangeKeys.has(rangeKey)) {
				summary.lineRangeKeys.add(rangeKey);
				summary.line_ranges.push(anchor.line_range);
			}
			const issue = await checkCaptureAnchor(repoRoot, event, filePath, anchor.line_range);
			if (issue) staleAnchors.push(issue);
		}
	}

	const staleCount = staleAnchors.length;
	if (staleCount > 0) {
		warnings.push(`${staleCount} captured source anchor(s) need review.`);
	}

	return {
		session_id: sessionId,
		total_events: events.length,
		counts_by_kind: counts,
		first_event_at: events[0]?.occurred_at,
		last_event_at: events.at(-1)?.occurred_at,
		files: [...files.values()]
			.map(({ lineRangeKeys: _lineRangeKeys, ...file }) => file)
			.sort((a, b) => b.event_count - a.event_count || a.file_path.localeCompare(b.file_path)),
		prompt_samples: promptSamples.slice(0, DEFAULT_PROMPT_SAMPLE_LIMIT),
		codemap_calls: [...codemapCalls].sort(),
		graph_writes: [...graphWrites].sort(),
		writeback_suggestions: [...writebackSuggestions].sort(),
		stale_anchors: staleAnchors,
		warnings: [...new Set(warnings)],
	};
}

function getFileSummary(
	files: Map<string, MutableFileSummary>,
	filePath: string,
): MutableFileSummary {
	const existing = files.get(filePath);
	if (existing) return existing;
	const next: MutableFileSummary = {
		file_path: filePath,
		event_count: 0,
		inspected_events: 0,
		modified_events: 0,
		recall_hit_events: 0,
		writeback_suggestion_events: 0,
		graph_write_events: 0,
		line_ranges: [],
		lineRangeKeys: new Set(),
	};
	files.set(filePath, next);
	return next;
}

function incrementFileEventSummary(
	summary: MutableFileSummary,
	kind: CaptureEventKind,
): void {
	summary.event_count += 1;
	if (kind === "file_inspected") summary.inspected_events += 1;
	if (kind === "file_modified") summary.modified_events += 1;
	if (kind === "recall_hit") summary.recall_hit_events += 1;
	if (kind === "writeback_suggestion") {
		summary.writeback_suggestion_events += 1;
	}
	if (kind === "graph_write") summary.graph_write_events += 1;
}

async function checkCaptureAnchor(
	repoRoot: string,
	event: CaptureEvent,
	filePath: string,
	lineRange: [number, number],
): Promise<CaptureAnchorIssue | null> {
	const safePath = safeRepoPath(repoRoot, filePath);
	if (!safePath.ok) {
		return {
			session_id: event.session_id,
			event_id: event.id,
			file_path: filePath,
			line_range: lineRange,
			reason: "read_error",
		};
	}
	let content: string;
	try {
		content = await fs.readFile(safePath.absolutePath, "utf8");
	} catch (err) {
		return {
			session_id: event.session_id,
			event_id: event.id,
			file_path: filePath,
			line_range: lineRange,
			reason:
				err instanceof Error &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
					? "missing"
					: "read_error",
		};
	}
	if (lineRange[1] > countLines(content)) {
		return {
			session_id: event.session_id,
			event_id: event.id,
			file_path: filePath,
			line_range: lineRange,
			reason: "range_out_of_bounds",
		};
	}
	return null;
}

async function buildProfile(
	repoRoot: string,
	sessions: CaptureSessionSummaryRecord[],
	source: CaptureProfile["source"],
	generatedAt: string,
): Promise<CaptureProfile> {
	const warnings: string[] = [];
	const activeAreas = buildActiveAreas(sessions);
	const recurringFiles = buildRecurringFiles(sessions);
	const unresolvedWritebackOpportunities = buildWritebackOpportunities(sessions);
	let recentDecisions: CaptureRecentDecision[] = [];
	try {
		const store = await GraphStore.load(repoRoot);
		recentDecisions = store
			.listNodes()
			.filter((node) => node.kind === "decision")
			.sort((a, b) => b.last_verified_at.localeCompare(a.last_verified_at))
			.slice(0, DEFAULT_RECENT_LIMIT)
			.map(decisionSummary);
	} catch (err) {
		warnings.push(`Could not read graph decisions for capture profile: ${String(err)}`);
	}

	return {
		version: CAPTURE_SUMMARY_VERSION,
		generated_at: generatedAt,
		source,
		active_areas: activeAreas,
		recurring_files: recurringFiles,
		recent_decisions: recentDecisions,
		unresolved_writeback_opportunities: unresolvedWritebackOpportunities,
		warnings,
	};
}

function buildActiveAreas(
	sessions: CaptureSessionSummaryRecord[],
): CaptureAreaSummary[] {
	const areas = new Map<
		string,
		{ event_count: number; files: Set<string>; sessions: Set<string> }
	>();
	for (const session of sessions) {
		for (const file of session.files) {
			const area = areaForFile(file.file_path);
			const entry =
				areas.get(area) ?? {
					event_count: 0,
					files: new Set<string>(),
					sessions: new Set<string>(),
				};
			entry.event_count += file.event_count;
			entry.files.add(file.file_path);
			entry.sessions.add(session.session_id);
			areas.set(area, entry);
		}
	}
	return [...areas.entries()]
		.map(([area, entry]) => ({
			area,
			event_count: entry.event_count,
			file_count: entry.files.size,
			session_ids: [...entry.sessions].sort(),
		}))
		.sort((a, b) => b.event_count - a.event_count || a.area.localeCompare(b.area))
		.slice(0, DEFAULT_RECENT_LIMIT);
}

function buildRecurringFiles(
	sessions: CaptureSessionSummaryRecord[],
): CaptureRecurringFile[] {
	const files = new Map<
		string,
		{
			event_count: number;
			inspected_events: number;
			modified_events: number;
			recall_hit_events: number;
			session_ids: Set<string>;
		}
	>();
	for (const session of sessions) {
		for (const file of session.files) {
			const entry =
				files.get(file.file_path) ?? {
					event_count: 0,
					inspected_events: 0,
					modified_events: 0,
					recall_hit_events: 0,
					session_ids: new Set<string>(),
				};
			entry.event_count += file.event_count;
			entry.inspected_events += file.inspected_events;
			entry.modified_events += file.modified_events;
			entry.recall_hit_events += file.recall_hit_events;
			entry.session_ids.add(session.session_id);
			files.set(file.file_path, entry);
		}
	}
	return [...files.entries()]
		.map(([file_path, entry]) => ({
			file_path,
			event_count: entry.event_count,
			inspected_events: entry.inspected_events,
			modified_events: entry.modified_events,
			recall_hit_events: entry.recall_hit_events,
			session_ids: [...entry.session_ids].sort(),
		}))
		.sort((a, b) => b.event_count - a.event_count || a.file_path.localeCompare(b.file_path))
		.slice(0, DEFAULT_RECENT_LIMIT);
}

function buildWritebackOpportunities(
	sessions: CaptureSessionSummaryRecord[],
): CaptureWritebackOpportunity[] {
	const opportunities: CaptureWritebackOpportunity[] = [];
	for (const session of sessions) {
		const modifiedFiles = session.files.filter(
			(file) => file.modified_events > 0,
		);
		const suggestedFiles = session.files.filter(
			(file) => file.writeback_suggestion_events > 0,
		);
		const hasGraphWriteEvents = (session.counts_by_kind.graph_write ?? 0) > 0;
		const reasons: string[] = [];
		if (suggestedFiles.length > 0) reasons.push("writeback_suggestion_captured");
		if (modifiedFiles.length > 0 && !hasGraphWriteEvents) {
			reasons.push("modified_files_without_graph_write");
		}
		if (reasons.length === 0) continue;
		opportunities.push({
			session_id: session.session_id,
			reasons,
			files: [...new Set([...modifiedFiles, ...suggestedFiles].map((file) => file.file_path))].sort(),
			event_count:
				(session.counts_by_kind.writeback_suggestion ?? 0) +
				modifiedFiles.reduce((total, file) => total + file.modified_events, 0),
			last_event_at: session.last_event_at,
		});
	}
	return opportunities
		.sort((a, b) => (b.last_event_at ?? "").localeCompare(a.last_event_at ?? ""))
		.slice(0, DEFAULT_RECENT_LIMIT);
}

function sourceSummary(
	repoRoot: string,
	events: CaptureEvent[],
	sessionCount: number,
): CaptureProfile["source"] {
	return {
		events_path: captureEventPath(repoRoot),
		event_count: events.length,
		session_count: sessionCount,
		first_event_at: events[0]?.occurred_at,
		last_event_at: events.at(-1)?.occurred_at,
	};
}

function selectSummaryEvents(
	events: CaptureEvent[],
	options: Pick<CaptureSummaryOptions, "sessionId" | "limit">,
): CaptureEvent[] {
	const filtered =
		options.sessionId === undefined
			? events
			: events.filter((event) => event.session_id === options.sessionId);
	if (options.limit === undefined) return filtered;
	if (options.limit <= 0) return [];
	return filtered.length > options.limit
		? filtered.slice(-options.limit)
		: filtered;
}

function decisionSummary(node: Node): CaptureRecentDecision {
	return {
		id: node.id,
		name: node.name,
		summary: truncateText(node.summary, 220),
		last_verified_at: node.last_verified_at,
		source_files: [...new Set(node.sources.map((source) => source.file_path))],
	};
}

function captureTextSample(event: CaptureEvent, samples: string[]): void {
	if (event.kind !== "prompt" && event.kind !== "session_end") return;
	const text = stringPayload(event.payload, "text");
	if (!text) return;
	samples.push(truncateText(redactCaptureText(text), 240));
}

function captureToolName(event: CaptureEvent, calls: Set<string>): void {
	if (event.kind !== "codemap_call") return;
	const tool =
		stringPayload(event.payload, "tool") ??
		stringPayload(event.payload, "tool_name") ??
		event.source?.command;
	if (tool) calls.add(truncateText(tool, 120));
}

function captureGraphWrites(event: CaptureEvent, writes: Set<string>): void {
	if (event.kind !== "graph_write") return;
	for (const value of stringPayloadValues(event.payload, ["node_id", "node"])) {
		writes.add(value);
	}
	for (const value of arrayPayloadValues(event.payload, ["node_ids", "nodes"])) {
		writes.add(value);
	}
}

function captureWritebackSuggestion(
	event: CaptureEvent,
	suggestions: Set<string>,
): void {
	if (event.kind !== "writeback_suggestion") return;
	const text =
		stringPayload(event.payload, "title") ??
		stringPayload(event.payload, "suggestion") ??
		stringPayload(event.payload, "text") ??
		event.id;
	suggestions.add(truncateText(redactCaptureText(text), 180));
}

function stringPayload(
	payload: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value.trim()
		? redactCaptureText(value.trim())
		: undefined;
}

function stringPayloadValues(
	payload: Record<string, unknown>,
	keys: string[],
): string[] {
	return keys
		.map((key) => stringPayload(payload, key))
		.filter((value): value is string => value !== undefined);
}

function arrayPayloadValues(
	payload: Record<string, unknown>,
	keys: string[],
): string[] {
	const values: string[] = [];
	for (const key of keys) {
		const value = payload[key];
		if (!Array.isArray(value)) continue;
		for (const entry of value) {
			if (typeof entry === "string" && entry.trim()) values.push(entry.trim());
		}
	}
	return values;
}

function shouldExcludePath(filePath: string, excludes: string[]): boolean {
	if (/(^|\/)(\.git|\.codemap|node_modules|dist|coverage)(\/|$)/.test(filePath)) {
		return true;
	}
	return excludes.some((pattern) => matchesPattern(filePath, pattern));
}

function matchesPattern(value: string, pattern: string): boolean {
	const normalized = normalizeRepoPath(pattern.trim());
	if (!normalized) return false;
	if (normalized.endsWith("/**")) {
		const prefix = normalized.slice(0, -3);
		return value === prefix || value.startsWith(`${prefix}/`);
	}
	if (normalized.endsWith("/*")) {
		const prefix = normalized.slice(0, -2);
		return value.startsWith(`${prefix}/`) && !value.slice(prefix.length + 1).includes("/");
	}
	if (normalized.includes("*")) {
		const escaped = normalized
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		return new RegExp(`^${escaped}$`).test(value);
	}
	return value === normalized || value.startsWith(`${normalized}/`);
}

function areaForFile(filePath: string): string {
	const parts = filePath.split("/").filter(Boolean);
	return parts.length <= 1 ? "root" : parts[0];
}

function countLines(content: string): number {
	if (content.length === 0) return 1;
	const lines = content.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	return Math.max(1, lines.length);
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 16)).trimEnd()} ... truncated`;
}

function cleanList(values: string[] | undefined): string[] {
	return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fs.rename(tmp, filePath);
}
