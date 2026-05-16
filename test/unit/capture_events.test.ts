import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	appendCaptureEvent,
	captureEventPath,
	readCaptureEvents,
	summarizeCaptureSession,
} from "../../src/capture_events.js";
import { GraphStore } from "../../src/graph.js";

let tmpRoot: string;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-capture-"));
});

afterEach(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("capture events", () => {
	test("appends and reads validated JSONL events under the rebuildable capture index", async () => {
		const event = await appendCaptureEvent(tmpRoot, {
			id: "evt-1",
			session_id: "session-a",
			kind: "file_inspected",
			occurred_at: "2026-05-16T09:00:00.000Z",
			source: { agent: "codex" },
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 3] }],
			payload: { reason: "read auth guard" },
		});

		expect(event).toMatchObject({
			version: 1,
			id: "evt-1",
			session_id: "session-a",
			kind: "file_inspected",
			source: { agent: "codex" },
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 3] }],
		});
		expect(captureEventPath(tmpRoot)).toEndWith(
			path.join(".codemap", "index", "capture", "events.jsonl"),
		);

		const events = await readCaptureEvents(tmpRoot);
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(event);
	});

	test("rejects invalid or out-of-repo capture anchors", async () => {
		await expect(
			appendCaptureEvent(tmpRoot, {
				session_id: "session-a",
				kind: "file_modified",
				anchors: [{ file_path: "../outside.ts", line_range: [1, 2] }],
			}),
		).rejects.toThrow("repo-relative");

		await expect(
			appendCaptureEvent(tmpRoot, {
				session_id: "session-a",
				kind: "file_modified",
				anchors: [{ file_path: "src/auth.ts", line_range: [3, 1] }],
			}),
		).rejects.toThrow("line_range");
	});

	test("rejects invalid event kinds and payload shapes", async () => {
		await expect(
			appendCaptureEvent(tmpRoot, {
				session_id: "session-a",
				kind: "unknown",
			}),
		).rejects.toThrow("invalid capture event kind");

		await expect(
			appendCaptureEvent(tmpRoot, {
				session_id: "session-a",
				kind: "prompt",
				payload: ["not", "an", "object"] as never,
			}),
		).rejects.toThrow("payload");
	});

	test("redacts sensitive prompt and tool-output text before storage", async () => {
		await appendCaptureEvent(tmpRoot, {
			id: "evt-secret",
			session_id: "session-a",
			kind: "prompt",
			payload: {
				text: "Use token=abc123456789 and key sk-abc123456789SECRET",
			},
		});

		const [event] = await readCaptureEvents(tmpRoot);
		expect(event?.payload.text).toContain("token=[redacted]");
		expect(event?.payload.text).toContain("sk-[redacted]");
		expect(event?.payload.text).not.toContain("abc123456789SECRET");
	});

	test("capture storage never creates or mutates graph memory", async () => {
		const store = await GraphStore.load(tmpRoot);
		store.upsertNode({
			id: "auth/decision",
			kind: "decision",
			name: "Auth decision",
			summary: "Use the existing auth guard.",
			sources: [
				{
					file_path: "src/auth.ts",
					line_range: [1, 3],
					content_hash: "sha256:placeholder",
				},
			],
			tags: [],
			aliases: [],
			status: "active",
			confidence: 0.9,
			last_verified_at: "2026-05-16T09:00:00.000Z",
		});
		await store.save();
		const graphPath = path.join(tmpRoot, ".codemap", "graph.json");
		const before = await fs.readFile(graphPath, "utf8");

		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "graph_write",
			payload: { node_id: "auth/decision" },
		});

		expect(await fs.readFile(graphPath, "utf8")).toBe(before);
	});

	test("summarizes a session without including other sessions", async () => {
		await appendCaptureEvent(tmpRoot, {
			id: "evt-1",
			session_id: "session-a",
			kind: "prompt",
			occurred_at: "2026-05-16T09:00:00.000Z",
		});
		await appendCaptureEvent(tmpRoot, {
			id: "evt-2",
			session_id: "session-b",
			kind: "file_modified",
			occurred_at: "2026-05-16T09:01:00.000Z",
		});
		await appendCaptureEvent(tmpRoot, {
			id: "evt-3",
			session_id: "session-a",
			kind: "codemap_call",
			occurred_at: "2026-05-16T09:02:00.000Z",
		});

		const summary = await summarizeCaptureSession(tmpRoot, {
			sessionId: "session-a",
		});

		expect(summary.session_id).toBe("session-a");
		expect(summary.total_events).toBe(2);
		expect(summary.counts_by_kind.prompt).toBe(1);
		expect(summary.counts_by_kind.codemap_call).toBe(1);
		expect(summary.events.map((event) => event.id)).toEqual(["evt-1", "evt-3"]);
	});
});
