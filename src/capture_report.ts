import {
	type CaptureAnchor,
	type CaptureEvent,
	type CaptureEventKind,
	type CaptureEventReadIssue,
	type CaptureEventReadRecord,
	captureEventPath,
	readCaptureEventRecords,
	redactCaptureText,
} from "./capture_events.js";
import {
	buildCaptureSummaries,
	type CaptureAnchorIssue,
	type CaptureProfile,
	type CaptureSessionFileSummary,
	type CaptureSessionSummaryRecord,
	captureProfilePath,
	captureSessionsPath,
} from "./capture_summaries.js";

const CAPTURE_REPORT_VERSION = 1 as const;
const PAYLOAD_SUMMARY_CHARS = 240;

export interface CaptureReportOptions {
	sessionId?: string;
	limit?: number;
	generatedAt?: string;
}

export interface CaptureReportTimelineEntry {
	event_id: string;
	line_number: number;
	kind: CaptureEventKind;
	occurred_at: string;
	source?: CaptureEvent["source"];
	anchors: CaptureAnchor[];
	payload_summary: string;
}

export interface CaptureReportEventDetail {
	event_id: string;
	line_number: number;
	occurred_at: string;
	anchors: CaptureAnchor[];
	payload_summary: string;
}

export interface CaptureReportGraphWrite extends CaptureReportEventDetail {
	node_ids: string[];
}

export interface CaptureReportBudgetRecord extends CaptureReportEventDetail {
	budget_bytes?: number;
	used_bytes?: number;
	remaining_bytes?: number;
	within_budget?: boolean;
	over_budget: boolean;
	omitted: Record<string, number>;
	omitted_results: number;
}

export interface CaptureReportBudgetUsage {
	total_records: number;
	max_budget_bytes?: number;
	max_used_bytes?: number;
	over_budget_count: number;
	omitted_results: number;
	records: CaptureReportBudgetRecord[];
}

export interface CaptureReportSession {
	session_id: string;
	total_events: number;
	counts_by_kind: Partial<Record<CaptureEventKind, number>>;
	first_event_at?: string;
	last_event_at?: string;
	files: CaptureSessionFileSummary[];
	timeline: CaptureReportTimelineEntry[];
	recall_hits: CaptureReportEventDetail[];
	writeback_suggestions: CaptureReportEventDetail[];
	graph_writes: CaptureReportGraphWrite[];
	budget_usage: CaptureReportBudgetUsage;
	stale_anchors: CaptureAnchorIssue[];
	warnings: string[];
}

export interface CaptureReportResponse {
	ok: true;
	version: typeof CAPTURE_REPORT_VERSION;
	generated_at: string;
	filters: {
		session_id: string | null;
		limit: number | null;
	};
	paths: {
		events: string;
		sessions: string;
		profile: string;
	};
	source: {
		events_path: string;
		total_valid_event_count: number;
		selected_event_count: number;
		ignored_event_count: number;
		session_count: number;
		first_event_at?: string;
		last_event_at?: string;
	};
	totals: {
		counts_by_kind: Partial<Record<CaptureEventKind, number>>;
		recall_hits: number;
		writeback_suggestions: number;
		graph_writes: number;
		files_touched: number;
		stale_anchors: number;
		budget_records: number;
		ignored_events: number;
	};
	budget_usage: CaptureReportBudgetUsage;
	sessions: CaptureReportSession[];
	profile: CaptureProfile;
	ignored_events: CaptureEventReadIssue[];
	warnings: string[];
}

interface BudgetFields {
	budget_bytes?: number;
	used_bytes?: number;
	remaining_bytes?: number;
	within_budget?: boolean;
	omitted: Record<string, number>;
	omitted_results: number;
}

export async function buildCaptureReport(
	repoRoot: string,
	options: CaptureReportOptions = {},
): Promise<CaptureReportResponse> {
	const generatedAt = options.generatedAt ?? new Date().toISOString();
	const readResult = await readCaptureEventRecords(repoRoot);
	const matchingSessionRecordCount = countSessionRecords(
		readResult.records,
		options.sessionId,
	);
	const selectedRecords = selectReportRecords(readResult.records, options);
	const selectedEvents = selectedRecords.map((record) => record.event);
	const summaries = await buildCaptureSummaries(repoRoot, {
		sessionId: options.sessionId,
		limit: options.limit,
		events: readResult.events,
		write: false,
		generatedAt,
	});
	const summaryBySession = new Map(
		summaries.sessions.map((session) => [session.session_id, session]),
	);
	const sessions = buildReportSessions(selectedRecords, summaryBySession);
	const sortedEvents = sortRecordsByTime(selectedRecords).map(
		(record) => record.event,
	);
	const budgetUsage = summarizeBudgetUsage(
		sessions.flatMap((session) => session.budget_usage.records),
	);
	const warnings = new Set<string>(summaries.warnings);
	if (readResult.ignored_events.length > 0) {
		warnings.add(
			`${readResult.ignored_events.length} capture event line(s) were ignored; see ignored_events.`,
		);
	}
	if (options.sessionId !== undefined && matchingSessionRecordCount === 0) {
		warnings.add(`No capture events found for session ${options.sessionId}.`);
	}

	return {
		ok: true,
		version: CAPTURE_REPORT_VERSION,
		generated_at: generatedAt,
		filters: {
			session_id: options.sessionId ?? null,
			limit: options.limit ?? null,
		},
		paths: {
			events: captureEventPath(repoRoot),
			sessions: captureSessionsPath(repoRoot),
			profile: captureProfilePath(repoRoot),
		},
		source: {
			events_path: readResult.storage_path,
			total_valid_event_count: readResult.events.length,
			selected_event_count: selectedEvents.length,
			ignored_event_count: readResult.ignored_events.length,
			session_count: sessions.length,
			first_event_at: sortedEvents[0]?.occurred_at,
			last_event_at: sortedEvents.at(-1)?.occurred_at,
		},
		totals: {
			counts_by_kind: countKinds(selectedEvents),
			recall_hits: selectedEvents.filter((event) => event.kind === "recall_hit")
				.length,
			writeback_suggestions: selectedEvents.filter(
				(event) => event.kind === "writeback_suggestion",
			).length,
			graph_writes: selectedEvents.filter(
				(event) => event.kind === "graph_write",
			).length,
			files_touched: countTouchedFiles(sessions),
			stale_anchors: sessions.reduce(
				(total, session) => total + session.stale_anchors.length,
				0,
			),
			budget_records: budgetUsage.total_records,
			ignored_events: readResult.ignored_events.length,
		},
		budget_usage: budgetUsage,
		sessions,
		profile: summaries.profile,
		ignored_events: readResult.ignored_events,
		warnings: [...warnings],
	};
}

function countSessionRecords(
	records: CaptureEventReadRecord[],
	sessionId: string | undefined,
): number {
	if (sessionId === undefined) return records.length;
	return records.filter((record) => record.event.session_id === sessionId).length;
}

function selectReportRecords(
	records: CaptureEventReadRecord[],
	options: Pick<CaptureReportOptions, "sessionId" | "limit">,
): CaptureEventReadRecord[] {
	const filtered =
		options.sessionId === undefined
			? records
			: records.filter(
					(record) => record.event.session_id === options.sessionId,
				);
	if (options.limit === undefined) return filtered;
	if (options.limit <= 0) return [];
	return filtered.length > options.limit
		? filtered.slice(-options.limit)
		: filtered;
}

function buildReportSessions(
	records: CaptureEventReadRecord[],
	summaryBySession: Map<string, CaptureSessionSummaryRecord>,
): CaptureReportSession[] {
	const bySession = new Map<string, CaptureEventReadRecord[]>();
	for (const record of records) {
		const sessionRecords = bySession.get(record.event.session_id) ?? [];
		sessionRecords.push(record);
		bySession.set(record.event.session_id, sessionRecords);
	}

	const sessions: CaptureReportSession[] = [];
	for (const [sessionId, sessionRecords] of bySession) {
		const sorted = sortRecordsByTime(sessionRecords);
		const events = sessionRecords.map((record) => record.event);
		const timeline = sorted.map(timelineEntry);
		const budgetRecords = sorted
			.map((record) => budgetRecord(record))
			.filter((record): record is CaptureReportBudgetRecord => record !== null);
		const summary = summaryBySession.get(sessionId);
		sessions.push({
			session_id: sessionId,
			total_events: events.length,
			counts_by_kind: countKinds(events),
			first_event_at: timeline[0]?.occurred_at,
			last_event_at: timeline.at(-1)?.occurred_at,
			files: summary?.files ?? [],
			timeline,
			recall_hits: sorted
				.filter((record) => record.event.kind === "recall_hit")
				.map(eventDetail),
			writeback_suggestions: sorted
				.filter((record) => record.event.kind === "writeback_suggestion")
				.map(eventDetail),
			graph_writes: sorted
				.filter((record) => record.event.kind === "graph_write")
				.map(graphWriteDetail),
			budget_usage: summarizeBudgetUsage(budgetRecords),
			stale_anchors: summary?.stale_anchors ?? [],
			warnings: summary?.warnings ?? [],
		});
	}

	return sessions.sort(
		(a, b) =>
			(a.first_event_at ?? "").localeCompare(b.first_event_at ?? "") ||
			a.session_id.localeCompare(b.session_id),
	);
}

function sortRecordsByTime(
	records: CaptureEventReadRecord[],
): CaptureEventReadRecord[] {
	return [...records].sort(
		(a, b) =>
			a.event.occurred_at.localeCompare(b.event.occurred_at) ||
			a.line_number - b.line_number,
	);
}

function timelineEntry(
	record: CaptureEventReadRecord,
): CaptureReportTimelineEntry {
	return {
		event_id: record.event.id,
		line_number: record.line_number,
		kind: record.event.kind,
		occurred_at: record.event.occurred_at,
		source: record.event.source,
		anchors: record.event.anchors,
		payload_summary: summarizePayload(record.event),
	};
}

function eventDetail(record: CaptureEventReadRecord): CaptureReportEventDetail {
	return {
		event_id: record.event.id,
		line_number: record.line_number,
		occurred_at: record.event.occurred_at,
		anchors: record.event.anchors,
		payload_summary: summarizePayload(record.event),
	};
}

function graphWriteDetail(
	record: CaptureEventReadRecord,
): CaptureReportGraphWrite {
	return {
		...eventDetail(record),
		node_ids: graphWriteNodeIds(record.event.payload),
	};
}

function budgetRecord(
	record: CaptureEventReadRecord,
): CaptureReportBudgetRecord | null {
	const fields = extractBudgetFields(record.event.payload);
	if (!fields) return null;
	const overBudget =
		fields.within_budget === false ||
		(fields.budget_bytes !== undefined &&
			fields.used_bytes !== undefined &&
			fields.used_bytes > fields.budget_bytes);
	return {
		...eventDetail(record),
		budget_bytes: fields.budget_bytes,
		used_bytes: fields.used_bytes,
		remaining_bytes: fields.remaining_bytes,
		within_budget: fields.within_budget,
		over_budget: overBudget,
		omitted: fields.omitted,
		omitted_results: fields.omitted_results,
	};
}

function summarizeBudgetUsage(
	records: CaptureReportBudgetRecord[],
): CaptureReportBudgetUsage {
	return {
		total_records: records.length,
		max_budget_bytes: maxNumber(records.map((record) => record.budget_bytes)),
		max_used_bytes: maxNumber(records.map((record) => record.used_bytes)),
		over_budget_count: records.filter((record) => record.over_budget).length,
		omitted_results: records.reduce(
			(total, record) => total + record.omitted_results,
			0,
		),
		records,
	};
}

function countKinds(
	events: CaptureEvent[],
): Partial<Record<CaptureEventKind, number>> {
	const counts: Partial<Record<CaptureEventKind, number>> = {};
	for (const event of events) {
		counts[event.kind] = (counts[event.kind] ?? 0) + 1;
	}
	return counts;
}

function countTouchedFiles(sessions: CaptureReportSession[]): number {
	const files = new Set<string>();
	for (const session of sessions) {
		for (const file of session.files) files.add(file.file_path);
	}
	return files.size;
}

function summarizePayload(event: CaptureEvent): string {
	const raw = JSON.stringify(event.payload);
	if (raw === "{}") return "";
	return truncateText(redactCaptureText(raw), PAYLOAD_SUMMARY_CHARS);
}

function extractBudgetFields(
	payload: Record<string, unknown>,
): BudgetFields | null {
	const source = findBudgetSource(payload);
	const budgetBytes = numberField(source, [
		"budget_bytes",
		"limit_bytes",
		"response_budget_bytes",
	]);
	const usedBytes = numberField(source, [
		"used_bytes",
		"response_bytes",
		"payload_bytes",
	]);
	const remainingBytes = numberField(source, ["remaining_bytes"]);
	const withinBudget = booleanField(source, ["within_budget"]);
	const omitted = omittedFields(source);
	const omittedResults = Object.values(omitted).reduce(
		(total, value) => total + value,
		0,
	);
	if (
		budgetBytes === undefined &&
		usedBytes === undefined &&
		remainingBytes === undefined &&
		withinBudget === undefined &&
		omittedResults === 0
	) {
		return null;
	}
	return {
		budget_bytes: budgetBytes,
		used_bytes: usedBytes,
		remaining_bytes: remainingBytes,
		within_budget: withinBudget,
		omitted,
		omitted_results: omittedResults,
	};
}

function findBudgetSource(
	payload: Record<string, unknown>,
): Record<string, unknown> {
	if (isRecord(payload.budget)) return payload.budget;
	if (isRecord(payload.recall_budget)) return payload.recall_budget;
	if (isRecord(payload.response) && isRecord(payload.response.budget)) {
		return payload.response.budget;
	}
	if (isRecord(payload.result) && isRecord(payload.result.budget)) {
		return payload.result.budget;
	}
	return payload;
}

function numberField(
	payload: Record<string, unknown>,
	keys: string[],
): number | undefined {
	for (const key of keys) {
		const value = payload[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function booleanField(
	payload: Record<string, unknown>,
	keys: string[],
): boolean | undefined {
	for (const key of keys) {
		const value = payload[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function omittedFields(
	payload: Record<string, unknown>,
): Record<string, number> {
	const omitted: Record<string, number> = {};
	const nested = payload.omitted;
	if (isRecord(nested)) {
		for (const [key, value] of Object.entries(nested)) {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
				omitted[key] = value;
			}
		}
	} else if (
		typeof nested === "number" &&
		Number.isFinite(nested) &&
		nested > 0
	) {
		omitted.results = nested;
	}
	for (const key of ["omitted_results", "omitted_count"]) {
		const value = payload[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			omitted.results = (omitted.results ?? 0) + value;
		}
	}
	return omitted;
}

function graphWriteNodeIds(payload: Record<string, unknown>): string[] {
	const nodeIds = new Set<string>();
	for (const key of ["node_id", "node"]) {
		const value = payload[key];
		if (typeof value === "string" && value.trim()) nodeIds.add(value.trim());
		if (isRecord(value) && typeof value.id === "string" && value.id.trim()) {
			nodeIds.add(value.id.trim());
		}
	}
	for (const key of ["node_ids", "nodes"]) {
		const value = payload[key];
		if (!Array.isArray(value)) continue;
		for (const entry of value) {
			if (typeof entry === "string" && entry.trim()) nodeIds.add(entry.trim());
			if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
				nodeIds.add(entry.id.trim());
			}
		}
	}
	return [...nodeIds].sort();
}

function maxNumber(values: Array<number | undefined>): number | undefined {
	let max: number | undefined;
	for (const value of values) {
		if (value === undefined) continue;
		max = max === undefined ? value : Math.max(max, value);
	}
	return max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 16)).trimEnd()} ... truncated`;
}
