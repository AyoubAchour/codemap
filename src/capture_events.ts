import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { lock } from "proper-lockfile";

import { normalizeRepoPath } from "./util/repo_path.js";

const CAPTURE_EVENT_VERSION = 1 as const;
const CAPTURE_INDEX_DIR = ".codemap/index/capture";
const CAPTURE_EVENTS_FILE = "events.jsonl";

export const CAPTURE_EVENT_KINDS = [
	"session_start",
	"session_end",
	"prompt",
	"file_inspected",
	"file_modified",
	"codemap_call",
	"recall_hit",
	"writeback_suggestion",
	"graph_write",
] as const;

export type CaptureEventKind = (typeof CAPTURE_EVENT_KINDS)[number];

export interface CaptureAnchor {
	file_path: string;
	line_range: [number, number];
}

export interface CaptureEventSource {
	agent?: string;
	command?: string;
}

export type CapturePayload = Record<string, unknown>;

export interface CaptureEvent {
	version: typeof CAPTURE_EVENT_VERSION;
	id: string;
	session_id: string;
	kind: CaptureEventKind;
	occurred_at: string;
	source?: CaptureEventSource;
	anchors: CaptureAnchor[];
	payload: CapturePayload;
}

export interface CaptureEventInput {
	version?: unknown;
	id?: string;
	session_id?: string;
	kind: CaptureEventKind | string;
	occurred_at?: string;
	source?: CaptureEventSource;
	anchors?: CaptureAnchor[];
	payload?: CapturePayload;
}

export interface ReadCaptureEventsOptions {
	sessionId?: string;
	kinds?: CaptureEventKind[];
	limit?: number;
}

export interface CaptureSessionSummary {
	storage_path: string;
	session_id?: string;
	total_events: number;
	counts_by_kind: Partial<Record<CaptureEventKind, number>>;
	first_event_at?: string;
	last_event_at?: string;
	events: CaptureEvent[];
}

export function captureEventPath(repoRoot: string): string {
	return path.join(repoRoot, CAPTURE_INDEX_DIR, CAPTURE_EVENTS_FILE);
}

export function isCaptureEventKind(value: string): value is CaptureEventKind {
	return CAPTURE_EVENT_KINDS.includes(value as CaptureEventKind);
}

export async function appendCaptureEvent(
	repoRoot: string,
	input: CaptureEventInput,
): Promise<CaptureEvent> {
	const event = normalizeCaptureEvent(repoRoot, input, false);
	const logPath = captureEventPath(repoRoot);
	await ensureCaptureLog(logPath);

	const release = await lock(logPath, {
		realpath: false,
		retries: { retries: 3, minTimeout: 10, maxTimeout: 50 },
	});
	try {
		await fs.appendFile(logPath, `${JSON.stringify(event)}\n`, "utf8");
	} finally {
		await release();
	}

	return event;
}

export async function readCaptureEvents(
	repoRoot: string,
	options: ReadCaptureEventsOptions = {},
): Promise<CaptureEvent[]> {
	const logPath = captureEventPath(repoRoot);
	let content: string;
	try {
		content = await fs.readFile(logPath, "utf8");
	} catch (err) {
		if (
			err instanceof Error &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return [];
		}
		throw err;
	}

	const events = content
		.split(/\r?\n/)
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => line.trim().length > 0)
		.map(({ line, index }) => {
			try {
				return normalizeCaptureEvent(
					repoRoot,
					JSON.parse(line) as CaptureEventInput,
					true,
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(
					`Invalid capture event at line ${index + 1}: ${message}`,
				);
			}
		})
		.filter((event) =>
			options.sessionId === undefined
				? true
				: event.session_id === options.sessionId,
		)
		.filter((event) =>
			options.kinds === undefined ? true : options.kinds.includes(event.kind),
		);

	if (options.limit !== undefined && events.length > options.limit) {
		return events.slice(-options.limit);
	}

	return events;
}

export async function summarizeCaptureSession(
	repoRoot: string,
	options: ReadCaptureEventsOptions = {},
): Promise<CaptureSessionSummary> {
	const allEvents = await readCaptureEvents(repoRoot, {
		kinds: options.kinds,
	});
	const sessionId = options.sessionId ?? allEvents.at(-1)?.session_id;
	const sessionEvents =
		sessionId === undefined
			? []
			: allEvents.filter((event) => event.session_id === sessionId);
	const events =
		options.limit !== undefined && sessionEvents.length > options.limit
			? sessionEvents.slice(-options.limit)
			: sessionEvents;

	const counts: Partial<Record<CaptureEventKind, number>> = {};
	for (const event of events) {
		counts[event.kind] = (counts[event.kind] ?? 0) + 1;
	}

	return {
		storage_path: captureEventPath(repoRoot),
		session_id: sessionId,
		total_events: events.length,
		counts_by_kind: counts,
		first_event_at: events[0]?.occurred_at,
		last_event_at: events.at(-1)?.occurred_at,
		events,
	};
}

export function redactCaptureText(text: string): string {
	return text
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
		.replace(
			/\b(token|api[_-]?key|secret|password)\s*([:=])\s*["']?[^"'\s,}]+["']?/gi,
			(_match, key: string, separator: string) =>
				`${key}${separator}[redacted]`,
		);
}

async function ensureCaptureLog(logPath: string): Promise<void> {
	await fs.mkdir(path.dirname(logPath), { recursive: true });
	const file = await fs.open(logPath, "a");
	await file.close();
}

function normalizeCaptureEvent(
	repoRoot: string,
	input: CaptureEventInput,
	stored: boolean,
): CaptureEvent {
	if (!input || typeof input !== "object") {
		throw new Error("capture event must be an object");
	}
	if (stored && input.version !== CAPTURE_EVENT_VERSION) {
		throw new Error(`capture event version must be ${CAPTURE_EVENT_VERSION}`);
	}

	const kind = String(input.kind);
	if (!isCaptureEventKind(kind)) {
		throw new Error(`invalid capture event kind: ${String(input.kind)}`);
	}

	const id = valueOrGenerated(input.id, "capture event id", stored, randomUUID);
	const sessionId = valueOrGenerated(
		input.session_id,
		"capture session_id",
		stored,
		() => "manual",
	);
	const occurredAt = valueOrGenerated(
		input.occurred_at,
		"capture occurred_at",
		stored,
		() => new Date().toISOString(),
	);
	assertUtcIsoTimestamp(occurredAt);

	return {
		version: CAPTURE_EVENT_VERSION,
		id,
		session_id: sessionId,
		kind,
		occurred_at: occurredAt,
		source: normalizeSource(input.source),
		anchors: (input.anchors ?? []).map((anchor) =>
			normalizeAnchor(repoRoot, anchor),
		),
		payload: normalizePayload(input.payload),
	};
}

function valueOrGenerated(
	value: string | undefined,
	label: string,
	stored: boolean,
	generate: () => string,
): string {
	if (typeof value === "string" && value.trim().length > 0) {
		return value.trim();
	}
	if (stored) {
		throw new Error(`${label} is required`);
	}
	return generate();
}

function normalizeSource(
	source: CaptureEventSource | undefined,
): CaptureEventSource | undefined {
	if (source === undefined) return undefined;
	const normalized: CaptureEventSource = {};
	if (typeof source.agent === "string" && source.agent.trim().length > 0) {
		normalized.agent = source.agent.trim();
	}
	if (typeof source.command === "string" && source.command.trim().length > 0) {
		normalized.command = source.command.trim();
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeAnchor(
	repoRoot: string,
	anchor: CaptureAnchor,
): CaptureAnchor {
	const normalizedPath = normalizeCapturePath(anchor.file_path);
	const resolvedRoot = path.resolve(repoRoot);
	const resolvedPath = path.resolve(resolvedRoot, normalizedPath);
	const rootPrefix = `${resolvedRoot}${path.sep}`;
	if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(rootPrefix)) {
		throw new Error("capture anchors must use repo-relative file paths");
	}

	if (
		!Array.isArray(anchor.line_range) ||
		anchor.line_range.length !== 2 ||
		!anchor.line_range.every((value) => Number.isInteger(value) && value > 0) ||
		anchor.line_range[0] > anchor.line_range[1]
	) {
		throw new Error(
			"capture anchor line_range must be [start, end] with positive start <= end",
		);
	}

	return {
		file_path: normalizedPath,
		line_range: [anchor.line_range[0], anchor.line_range[1]],
	};
}

function normalizeCapturePath(filePath: string): string {
	if (typeof filePath !== "string" || filePath.trim().length === 0) {
		throw new Error("capture anchors must use repo-relative file paths");
	}
	const normalized = normalizeRepoPath(filePath.trim());
	if (
		path.isAbsolute(normalized) ||
		/^[A-Za-z]:\//.test(normalized) ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../")
	) {
		throw new Error("capture anchors must use repo-relative file paths");
	}
	return normalized;
}

function assertUtcIsoTimestamp(value: string): void {
	const millis = Date.parse(value);
	if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
		throw new Error("capture occurred_at must be a UTC ISO timestamp");
	}
}

function normalizePayload(payload: CapturePayload | undefined): CapturePayload {
	const value = payload ?? {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("capture payload must be a JSON object");
	}
	return redactJson(value) as CapturePayload;
}

function redactJson(value: unknown): unknown {
	if (typeof value === "string") return redactCaptureText(value);
	if (Array.isArray(value)) return value.map((entry) => redactJson(entry));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry !== undefined) out[key] = redactJson(entry);
		}
		return out;
	}
	return value;
}
