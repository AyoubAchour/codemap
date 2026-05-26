import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	appendCaptureEvent,
	captureEventPath,
} from "../../src/capture_events.js";
import { buildCaptureReport } from "../../src/capture_report.js";
import {
	captureProfilePath,
	captureSessionsPath,
} from "../../src/capture_summaries.js";

let tmpRoot: string;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-report-"));
});

afterEach(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function write(relativePath: string, content: string): Promise<void> {
	const absolutePath = path.join(tmpRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content, "utf8");
}

describe("capture report", () => {
	test("reports an empty repo without creating graph or summary files", async () => {
		const report = await buildCaptureReport(tmpRoot, {
			generatedAt: "2026-05-16T09:00:00.000Z",
		});

		expect(report).toMatchObject({
			ok: true,
			version: 1,
			generated_at: "2026-05-16T09:00:00.000Z",
			source: {
				total_valid_event_count: 0,
				selected_event_count: 0,
				ignored_event_count: 0,
				session_count: 0,
			},
			totals: {
				recall_hits: 0,
				writeback_suggestions: 0,
				graph_writes: 0,
				budget_records: 0,
			},
			sessions: [],
			ignored_events: [],
			warnings: [],
		});
		await expect(
			fs.access(path.join(tmpRoot, ".codemap", "graph.json")),
		).rejects.toThrow();
		await expect(fs.access(captureSessionsPath(tmpRoot))).rejects.toThrow();
		await expect(fs.access(captureProfilePath(tmpRoot))).rejects.toThrow();
	});

	test("builds an ordered session timeline with recall, suggestion, graph, and budget evidence", async () => {
		await write("src/auth.ts", "export const auth = true;\n");
		await appendCaptureEvent(tmpRoot, {
			id: "evt-modified",
			session_id: "session-a",
			kind: "file_modified",
			occurred_at: "2026-05-16T09:02:00.000Z",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
		});
		await appendCaptureEvent(tmpRoot, {
			id: "evt-recall",
			session_id: "session-a",
			kind: "recall_hit",
			occurred_at: "2026-05-16T09:01:00.000Z",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
			payload: {
				budget: {
					budget_bytes: 1000,
					used_bytes: 900,
					remaining_bytes: 100,
					within_budget: true,
					omitted: { graph: 1, source: 2 },
				},
			},
		});
		await appendCaptureEvent(tmpRoot, {
			id: "evt-suggestion",
			session_id: "session-a",
			kind: "writeback_suggestion",
			occurred_at: "2026-05-16T09:03:00.000Z",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
			payload: { title: "Capture auth invariant" },
		});
		await appendCaptureEvent(tmpRoot, {
			id: "evt-graph",
			session_id: "session-a",
			kind: "graph_write",
			occurred_at: "2026-05-16T09:04:00.000Z",
			payload: {},
		});

		const report = await buildCaptureReport(tmpRoot, {
			generatedAt: "2026-05-16T09:05:00.000Z",
		});

		expect(report.source).toEqual(
			expect.objectContaining({
				total_valid_event_count: 4,
				selected_event_count: 4,
				session_count: 1,
				first_event_at: "2026-05-16T09:01:00.000Z",
				last_event_at: "2026-05-16T09:04:00.000Z",
			}),
		);
		expect(report.totals).toEqual(
			expect.objectContaining({
				recall_hits: 1,
				writeback_suggestions: 1,
				graph_writes: 1,
				files_touched: 1,
				budget_records: 1,
			}),
		);
		expect(report.totals.counts_by_kind).toEqual(
			expect.objectContaining({
				file_modified: 1,
				recall_hit: 1,
				writeback_suggestion: 1,
				graph_write: 1,
			}),
		);
		expect(report.budget_usage).toEqual(
			expect.objectContaining({
				total_records: 1,
				max_budget_bytes: 1000,
				max_used_bytes: 900,
				over_budget_count: 0,
				omitted_results: 3,
			}),
		);
		const session = report.sessions[0];
		expect(session.timeline.map((entry) => entry.event_id)).toEqual([
			"evt-recall",
			"evt-modified",
			"evt-suggestion",
			"evt-graph",
		]);
		expect(session.recall_hits.map((entry) => entry.event_id)).toEqual([
			"evt-recall",
		]);
		expect(
			session.writeback_suggestions.map((entry) => entry.event_id),
		).toEqual(["evt-suggestion"]);
		expect(session.graph_writes[0]).toEqual(
			expect.objectContaining({
				event_id: "evt-graph",
				node_ids: [],
			}),
		);
	});

	test("reports malformed capture lines as ignored events without aborting", async () => {
		await appendCaptureEvent(tmpRoot, {
			id: "evt-valid",
			session_id: "session-a",
			kind: "prompt",
			occurred_at: "2026-05-16T09:00:00.000Z",
		});
		await fs.appendFile(
			captureEventPath(tmpRoot),
			'{"kind":"prompt","api_key":"plain-secret-value"}\n',
			"utf8",
		);

		const report = await buildCaptureReport(tmpRoot);

		expect(report.source.selected_event_count).toBe(1);
		expect(report.source.ignored_event_count).toBe(1);
		expect(report.ignored_events[0]).toEqual(
			expect.objectContaining({
				line_number: 2,
				reason: "capture event version must be 1",
			}),
		);
		expect(report.ignored_events[0].raw_preview).toContain("[redacted]");
		expect(report.ignored_events[0].raw_preview).not.toContain(
			"plain-secret-value",
		);
		expect(report.warnings.join("\n")).toContain("ignored");
	});

	test("filters reports to a requested session before applying limits", async () => {
		await appendCaptureEvent(tmpRoot, {
			id: "evt-a1",
			session_id: "session-a",
			kind: "prompt",
			occurred_at: "2026-05-16T09:00:00.000Z",
		});
		await appendCaptureEvent(tmpRoot, {
			id: "evt-b1",
			session_id: "session-b",
			kind: "prompt",
			occurred_at: "2026-05-16T09:01:00.000Z",
		});
		await appendCaptureEvent(tmpRoot, {
			id: "evt-a2",
			session_id: "session-a",
			kind: "codemap_call",
			occurred_at: "2026-05-16T09:02:00.000Z",
		});

		const report = await buildCaptureReport(tmpRoot, {
			sessionId: "session-a",
			limit: 1,
		});

		expect(report.source.total_valid_event_count).toBe(3);
		expect(report.source.selected_event_count).toBe(1);
		expect(report.source.session_count).toBe(1);
		expect(report.sessions[0]).toEqual(
			expect.objectContaining({
				session_id: "session-a",
				total_events: 1,
			}),
		);
		expect(report.sessions[0].timeline.map((entry) => entry.event_id)).toEqual([
			"evt-a2",
		]);

		const missing = await buildCaptureReport(tmpRoot, {
			sessionId: "missing-session",
		});
		expect(missing.sessions).toEqual([]);
		expect(missing.warnings.join("\n")).toContain(
			"No capture events found for session missing-session.",
		);
	});
});
