import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { appendCaptureEvent, captureEventPath } from "../../src/capture_events.js";
import {
	buildCaptureSummaries,
	captureProfilePath,
	captureSessionsPath,
} from "../../src/capture_summaries.js";
import { GraphStore } from "../../src/graph.js";
import { hashBuffer, hashSourceRange } from "../../src/staleness.js";

let tmpRoot: string;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-summary-"));
});

afterEach(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function write(relativePath: string, content: string): Promise<void> {
	const absolutePath = path.join(tmpRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

describe("capture summaries", () => {
	test("writes rebuildable session summaries and a project recall profile", async () => {
		const source = "export const auth = true;\n";
		await write("src/auth.ts", source);
		const store = await GraphStore.load(tmpRoot);
		store.upsertNode({
			id: "auth/provider-choice",
			kind: "decision",
			name: "Auth provider choice",
			summary: "Use the existing auth provider instead of adding a second one.",
			sources: [
				{
					file_path: "src/auth.ts",
					line_range: [1, 1],
					content_hash: hashBuffer(Buffer.from(source)),
					range_hash: hashSourceRange(source, [1, 1]),
				},
			],
			tags: ["auth"],
			aliases: [],
			status: "active",
			confidence: 0.9,
			last_verified_at: "2026-05-16T09:00:00.000Z",
		});
		await store.save();
		const graphPath = path.join(tmpRoot, ".codemap", "graph.json");
		const graphBefore = await fs.readFile(graphPath, "utf8");

		await appendCaptureEvent(tmpRoot, {
			id: "evt-1",
			session_id: "session-a",
			kind: "prompt",
			occurred_at: "2026-05-16T09:00:00.000Z",
			payload: { text: "Review auth token=super-secret-value" },
		});
		await appendCaptureEvent(tmpRoot, {
			id: "evt-2",
			session_id: "session-a",
			kind: "file_modified",
			occurred_at: "2026-05-16T09:01:00.000Z",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
		});

		const response = await buildCaptureSummaries(tmpRoot, {
			write: true,
			generatedAt: "2026-05-16T09:02:00.000Z",
		});

		expect(response.wrote_files).toBe(true);
		expect(response.sessions[0]).toEqual(
			expect.objectContaining({
				session_id: "session-a",
				total_events: 2,
				prompt_samples: ["Review auth token=[redacted]"],
			}),
		);
		expect(response.sessions[0].files[0]).toEqual(
			expect.objectContaining({
				file_path: "src/auth.ts",
				modified_events: 1,
			}),
		);
		expect(response.profile.active_areas[0]).toEqual(
			expect.objectContaining({ area: "src", event_count: 1 }),
		);
		expect(response.profile.recent_decisions[0]).toEqual(
			expect.objectContaining({ id: "auth/provider-choice" }),
		);
		expect(response.profile.unresolved_writeback_opportunities[0]).toEqual(
			expect.objectContaining({
				session_id: "session-a",
				reasons: ["modified_files_without_graph_write"],
				files: ["src/auth.ts"],
			}),
		);
		expect(await fs.readFile(graphPath, "utf8")).toBe(graphBefore);
		await expect(fs.access(captureSessionsPath(tmpRoot))).resolves.toBeNull();
		await expect(fs.access(captureProfilePath(tmpRoot))).resolves.toBeNull();
	});

	test("refreshes summaries from changed capture evidence and tolerates deleting them", async () => {
		await write("src/auth.ts", "export const auth = true;\n");
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "file_inspected",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
		});

		const first = await buildCaptureSummaries(tmpRoot, { write: true });
		expect(first.source.event_count).toBe(1);
		await fs.rm(captureSessionsPath(tmpRoot));
		await fs.rm(captureProfilePath(tmpRoot));

		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "recall_hit",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
		});
		const refreshed = await buildCaptureSummaries(tmpRoot, { write: true });

		expect(refreshed.source.event_count).toBe(2);
		expect(refreshed.sessions[0].files[0]).toEqual(
			expect.objectContaining({
				event_count: 2,
				recall_hit_events: 1,
			}),
		);
	});

	test("skips malformed capture lines while summarizing valid events", async () => {
		await write("src/auth.ts", "export const auth = true;\n");
		await appendCaptureEvent(tmpRoot, {
			id: "evt-valid",
			session_id: "session-a",
			kind: "file_modified",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
		});
		await fs.appendFile(captureEventPath(tmpRoot), "{not valid json}\n", "utf8");

		const response = await buildCaptureSummaries(tmpRoot);

		expect(response.source.event_count).toBe(1);
		expect(response.sessions[0]).toEqual(
			expect.objectContaining({
				session_id: "session-a",
				total_events: 1,
			}),
		);
		expect(response.warnings.join("\n")).toContain("Invalid capture event");
	});

	test("counts empty graph write events as graph writes for opportunities", async () => {
		await write("src/auth.ts", "export const auth = true;\n");
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "file_modified",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
		});
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "graph_write",
			payload: {},
		});

		const response = await buildCaptureSummaries(tmpRoot);

		expect(response.sessions[0].counts_by_kind.graph_write).toBe(1);
		expect(response.sessions[0].graph_writes).toEqual([]);
		expect(response.profile.unresolved_writeback_opportunities).toEqual([]);
	});

	test("counts one file event once when it has multiple anchors in the same file", async () => {
		await write("src/auth.ts", "one\ntwo\nthree\n");
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "file_modified",
			anchors: [
				{ file_path: "src/auth.ts", line_range: [1, 1] },
				{ file_path: "src/auth.ts", line_range: [2, 2] },
			],
		});

		const response = await buildCaptureSummaries(tmpRoot);

		expect(response.sessions[0].files[0]).toEqual(
			expect.objectContaining({
				file_path: "src/auth.ts",
				event_count: 1,
				modified_events: 1,
				line_ranges: [
					[1, 1],
					[2, 2],
				],
			}),
		);
		expect(response.profile.active_areas[0]).toEqual(
			expect.objectContaining({ area: "src", event_count: 1 }),
		);
	});

	test("filters capture summary sessions before applying the event limit", async () => {
		await write("src/auth.ts", "one\n");
		await write("src/other.ts", "one\n");
		await appendCaptureEvent(tmpRoot, {
			id: "evt-a",
			session_id: "session-a",
			kind: "file_inspected",
			occurred_at: "2026-05-16T09:00:00.000Z",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
		});
		await appendCaptureEvent(tmpRoot, {
			id: "evt-b1",
			session_id: "session-b",
			kind: "file_inspected",
			occurred_at: "2026-05-16T09:01:00.000Z",
			anchors: [{ file_path: "src/other.ts", line_range: [1, 1] }],
		});
		await appendCaptureEvent(tmpRoot, {
			id: "evt-b2",
			session_id: "session-b",
			kind: "file_modified",
			occurred_at: "2026-05-16T09:02:00.000Z",
			anchors: [{ file_path: "src/other.ts", line_range: [1, 1] }],
		});

		const response = await buildCaptureSummaries(tmpRoot, {
			sessionId: "session-a",
			limit: 1,
		});

		expect(response.source.event_count).toBe(1);
		expect(response.source.session_count).toBe(1);
		expect(response.sessions).toHaveLength(1);
		expect(response.sessions[0]).toEqual(
			expect.objectContaining({
				session_id: "session-a",
				total_events: 1,
			}),
		);
		expect(response.sessions[0].files.map((file) => file.file_path)).toEqual([
			"src/auth.ts",
		]);
	});

	test("excludes sensitive paths and reports stale capture anchors", async () => {
		await write("src/auth.ts", "one\n");
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "file_inspected",
			anchors: [
				{ file_path: "src/auth.ts", line_range: [1, 3] },
				{ file_path: "secrets/token.txt", line_range: [1, 1] },
			],
		});

		const response = await buildCaptureSummaries(tmpRoot, {
			exclude: ["secrets/**"],
		});

		expect(response.sessions[0].files.map((file) => file.file_path)).toEqual([
			"src/auth.ts",
		]);
		expect(response.sessions[0].stale_anchors[0]).toEqual(
			expect.objectContaining({
				file_path: "src/auth.ts",
				reason: "range_out_of_bounds",
			}),
		);
		expect(response.sessions[0].warnings.join("\n")).toContain(
			"Excluded captured path",
		);
	});
});
