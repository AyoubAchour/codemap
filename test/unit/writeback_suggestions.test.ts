import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { appendCaptureEvent } from "../../src/capture_events.js";
import { GraphStore } from "../../src/graph.js";
import { buildWritebackSuggestions } from "../../src/writeback_suggestions.js";

const execFileAsync = promisify(execFile);

let tmpRoot: string;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-writeback-"));
});

afterEach(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function write(filePath: string, content: string): Promise<void> {
	const absolutePath = path.join(tmpRoot, filePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

async function fileHash(filePath: string): Promise<string> {
	const content = await fs.readFile(path.join(tmpRoot, filePath));
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function git(args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd: tmpRoot });
}

describe("writeback suggestions", () => {
	test("uses git changed files as read-only writeback evidence", async () => {
		await git(["init"]);
		await git(["config", "user.email", "test@example.com"]);
		await git(["config", "user.name", "Test User"]);
		await write("src/auth.ts", "export const auth = true;\n");
		await git(["add", "."]);
		await git(["commit", "-m", "seed"]);
		await write(
			"src/auth.ts",
			"export function requireActiveUser() { return true; }\n",
		);

		const response = await buildWritebackSuggestions(tmpRoot, {
			activeTopic: "auth-review",
			workSummary: "Fixed auth regression after review.",
			includeGit: true,
		});

		expect(response.evidence.git_changed_files).toEqual(["src/auth.ts"]);
		expect(response.suggestions.gotchas[0]).toEqual(
			expect.objectContaining({
				kind: "gotcha",
				source_candidates: [
					expect.objectContaining({
						file_path: "src/auth.ts",
						reasons: expect.arrayContaining(["git_changed"]),
					}),
				],
			}),
		);
		expect(response.total_suggestions).toBeGreaterThan(0);
	});

	test("uses git status evidence before the first commit", async () => {
		await git(["init"]);
		await write("src/auth.ts", "export const auth = true;\n");
		await git(["add", "."]);

		const response = await buildWritebackSuggestions(tmpRoot, {
			workSummary: "Implemented auth behavior.",
			includeGit: true,
		});

		expect(response.evidence.git_changed_files).toEqual(["src/auth.ts"]);
		expect(response.warnings).not.toEqual(
			expect.arrayContaining([
				expect.stringContaining("Git changed-file inspection unavailable"),
			]),
		);
	});

	test("uses inspected files to suggest invariant writeback without git", async () => {
		await write(
			"src/auth.ts",
			"export function requireActiveUser() { return true; }\n",
		);

		const response = await buildWritebackSuggestions(tmpRoot, {
			inspectedFiles: ["src/auth.ts"],
			workSummary: "Confirmed auth behavior invariant.",
			includeGit: false,
		});

		expect(response.evidence.inspected_files).toEqual(["src/auth.ts"]);
		expect(response.evidence.git_changed_files).toEqual([]);
		expect(response.suggestions.invariants[0]).toEqual(
			expect.objectContaining({
				kind: "invariant",
				source_candidates: [
					expect.objectContaining({
						file_path: "src/auth.ts",
						reasons: expect.arrayContaining(["inspected"]),
					}),
				],
			}),
		);
	});

	test("deduplicates absolute inspected paths with git-relative paths", async () => {
		await git(["init"]);
		await git(["config", "user.email", "test@example.com"]);
		await git(["config", "user.name", "Test User"]);
		await write("src/auth.ts", "export const auth = true;\n");
		await git(["add", "."]);
		await git(["commit", "-m", "seed"]);
		await write(
			"src/auth.ts",
			"export function requireActiveUser() { return true; }\n",
		);

		const response = await buildWritebackSuggestions(tmpRoot, {
			inspectedFiles: [path.join(tmpRoot, "src", "auth.ts")],
			workSummary: "Confirmed active user behavior invariant.",
			includeGit: true,
		});

		expect(response.evidence.inspected_files).toEqual(["src/auth.ts"]);
		expect(response.evidence.git_changed_files).toEqual(["src/auth.ts"]);
		const candidates = response.suggestions.invariants[0].source_candidates;
		expect(
			candidates.filter((file) => file.file_path === "src/auth.ts"),
		).toHaveLength(1);
		expect(candidates[0].reasons).toEqual(
			expect.arrayContaining(["git_changed", "inspected"]),
		);
	});

	test("orders related graph memories by quality for writeback decisions", async () => {
		await write("src/auth.ts", "export const auth = true;\n");
		const hash = await fileHash("src/auth.ts");
		const store = await GraphStore.load(tmpRoot);
		const baseNode = {
			kind: "decision" as const,
			name: "Auth writeback memory",
			summary: "Auth writeback memory for future agents.",
			sources: [
				{
					file_path: "src/auth.ts",
					line_range: [1, 1] as [number, number],
					content_hash: hash,
				},
			],
			tags: ["auth"],
			aliases: [],
			status: "active" as const,
			confidence: 0.9,
			last_verified_at: "2026-05-01T00:00:00Z",
		};
		store.upsertNode({
			id: "auth/a-old-memory",
			...baseNode,
			quality: {
				utility_score: 0.1,
				maturity: "superseded",
				confirmed_by_source: true,
				superseded_by: "auth/z-current-memory",
			},
		});
		store.upsertNode({
			id: "auth/z-current-memory",
			...baseNode,
			quality: {
				utility_score: 0.95,
				maturity: "stable",
				last_used_at: "2026-05-05T00:00:00Z",
				confirmed_by_source: true,
			},
		});
		await store.save();

		const response = await buildWritebackSuggestions(tmpRoot, {
			activeTopic: "auth",
			inspectedFiles: ["src/auth.ts"],
			workSummary: "Confirmed auth behavior invariant.",
		});

		expect(response.evidence.related_node_ids.slice(0, 2)).toEqual([
			"auth/z-current-memory",
			"auth/a-old-memory",
		]);
		expect(response.suggestions.invariants[0].related_node_ids.slice(0, 2)).toEqual(
			["auth/z-current-memory", "auth/a-old-memory"],
		);
	});

	test("scopes stale graph node ids to ranked related memories", async () => {
		await write("src/auth.ts", "export const auth = true;\n");
		await write("src/stale.ts", "export const stale = true;\n");
		const authHash = await fileHash("src/auth.ts");
		const staleHash = await fileHash("src/stale.ts");
		const store = await GraphStore.load(tmpRoot);
		for (let i = 0; i < 5; i++) {
			store.upsertNode({
				id: `auth/current-${i}`,
				kind: "decision",
				name: `Auth current memory ${i}`,
				summary: "Auth writeback memory for future agents.",
				sources: [
					{
						file_path: "src/auth.ts",
						line_range: [1, 1],
						content_hash: authHash,
					},
				],
				tags: ["auth"],
				aliases: [],
				status: "active",
				confidence: 0.95,
				last_verified_at: "2026-05-01T00:00:00Z",
				quality: {
					utility_score: 0.95,
					maturity: "stable",
					confirmed_by_source: true,
				},
			});
		}
		store.upsertNode({
			id: "auth/stale-low-trust",
			kind: "decision",
			name: "Auth stale low trust memory",
			summary: "Auth writeback memory for future agents.",
			sources: [
				{
					file_path: "src/stale.ts",
					line_range: [1, 1],
					content_hash: staleHash,
				},
			],
			tags: ["auth"],
			aliases: [],
			status: "active",
			confidence: 0.95,
			last_verified_at: "2026-05-01T00:00:00Z",
			quality: {
				utility_score: 0.1,
				maturity: "superseded",
				confirmed_by_source: true,
				superseded_by: "auth/current-0",
			},
		});
		await store.save();
		await write("src/stale.ts", "export const stale = false;\n");

		const response = await buildWritebackSuggestions(tmpRoot, {
			activeTopic: "auth",
			inspectedFiles: ["src/auth.ts"],
			workSummary: "Confirmed auth behavior invariant.",
		});

		expect(response.evidence.related_node_ids).not.toContain(
			"auth/stale-low-trust",
		);
		expect(response.evidence.stale_graph_node_ids).not.toContain(
			"auth/stale-low-trust",
		);
		expect(response.evidence.modified_files).not.toContain("src/stale.ts");
	});

	test("reports line ranges without trailing-newline inflation", async () => {
		await write("src/auth.ts", ["one", "two", "three", ""].join("\n"));

		const response = await buildWritebackSuggestions(tmpRoot, {
			inspectedFiles: ["src/auth.ts"],
			workSummary: "Confirmed auth behavior invariant.",
			includeGit: false,
		});

		expect(
			response.suggestions.invariants[0].source_candidates[0].line_range,
		).toEqual([1, 3]);
	});

	test("returns no suggestions when no repo-local evidence is available", async () => {
		const response = await buildWritebackSuggestions(tmpRoot, {
			workSummary: "General non-repo question.",
			includeGit: false,
		});

		expect(response.total_suggestions).toBe(0);
		expect(response.suggestions).toEqual({
			decisions: [],
			invariants: [],
			gotchas: [],
			links: [],
		});
		expect(response.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("No repo-local file evidence"),
			]),
		);
	});

	test("uses captured session file evidence without explicit file lists", async () => {
		await write(
			"src/auth.ts",
			"export function requireActiveUser() { return true; }\n",
		);
		await write("test/auth.test.ts", "expect(true).toBe(true);\n");
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "file_inspected",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
		});
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "file_modified",
			anchors: [{ file_path: "test/auth.test.ts", line_range: [1, 1] }],
		});

		const response = await buildWritebackSuggestions(tmpRoot, {
			captureSessionId: "session-a",
			workSummary: "Fixed auth review finding.",
			includeGit: false,
		});

		expect(response.evidence.capture_session).toEqual(
			expect.objectContaining({
				requested: "session-a",
				session_id: "session-a",
				total_events: 2,
				used_events: 2,
				captured_files: ["src/auth.ts", "test/auth.test.ts"],
			}),
		);
		expect(response.suggestions.gotchas[0].source_candidates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file_path: "test/auth.test.ts",
					reasons: expect.arrayContaining(["captured_modified"]),
				}),
				expect.objectContaining({
					file_path: "src/auth.ts",
					reasons: expect.arrayContaining(["captured_inspected"]),
				}),
			]),
		);
	});

	test("uses the latest capture session when requested", async () => {
		await write("src/old.ts", "export const oldValue = true;\n");
		await write("src/new.ts", "export const newValue = true;\n");
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "file_inspected",
			anchors: [{ file_path: "src/old.ts", line_range: [1, 1] }],
			occurred_at: "2026-05-16T09:00:00.000Z",
		});
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-b",
			kind: "file_inspected",
			anchors: [{ file_path: "src/new.ts", line_range: [1, 1] }],
			occurred_at: "2026-05-16T10:00:00.000Z",
		});

		const response = await buildWritebackSuggestions(tmpRoot, {
			includeLatestCaptureSession: true,
			workSummary: "Confirmed behavior invariant.",
			includeGit: false,
		});

		expect(response.evidence.capture_session).toEqual(
			expect.objectContaining({
				requested: "latest",
				session_id: "session-b",
				captured_files: ["src/new.ts"],
			}),
		);
		expect(response.evidence.capture_session?.captured_files).not.toContain(
			"src/old.ts",
		);
	});

	test("collapses repeated low-value capture events into one source candidate", async () => {
		await write("src/auth.ts", "export const auth = true;\n");
		for (let i = 0; i < 3; i += 1) {
			await appendCaptureEvent(tmpRoot, {
				session_id: "session-a",
				kind: "file_inspected",
				anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
			});
		}
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "prompt",
			payload: { text: "No file evidence here." },
		});

		const response = await buildWritebackSuggestions(tmpRoot, {
			captureSessionId: "session-a",
			workSummary: "Confirmed behavior invariant.",
			includeGit: false,
		});
		const candidates = response.suggestions.invariants[0].source_candidates;

		expect(
			candidates.filter((file) => file.file_path === "src/auth.ts"),
		).toHaveLength(1);
		expect(candidates[0].reasons).toEqual(["captured_inspected"]);
		expect(response.evidence.capture_session).toEqual(
			expect.objectContaining({
				total_events: 4,
				used_events: 3,
				captured_files: ["src/auth.ts"],
			}),
		);
	});

	test("capture-backed suggestions do not write graph memory", async () => {
		await write("src/auth.ts", "export const auth = true;\n");
		const store = await GraphStore.load(tmpRoot);
		store.upsertNode({
			id: "auth/existing",
			kind: "decision",
			name: "Auth existing decision",
			summary: "Keep this graph memory unchanged.",
			sources: [
				{
					file_path: "src/auth.ts",
					line_range: [1, 1],
					content_hash: await fileHash("src/auth.ts"),
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
		const before = await fs.readFile(graphPath, "utf8");
		await appendCaptureEvent(tmpRoot, {
			session_id: "session-a",
			kind: "file_modified",
			anchors: [{ file_path: "src/auth.ts", line_range: [1, 1] }],
		});

		await buildWritebackSuggestions(tmpRoot, {
			captureSessionId: "session-a",
			workSummary: "Fixed auth review finding.",
			includeGit: false,
		});

		expect(await fs.readFile(graphPath, "utf8")).toBe(before);
	});

	test("warns and ignores files outside the repository", async () => {
		const outside = path.join(os.tmpdir(), "codemap-outside.ts");
		await fs.writeFile(outside, "export const outside = true;\n");
		try {
			const response = await buildWritebackSuggestions(tmpRoot, {
				inspectedFiles: [outside],
				workSummary: "Confirmed behavior invariant.",
				includeGit: false,
			});

			expect(response.total_suggestions).toBe(0);
			expect(response.warnings).toEqual(
				expect.arrayContaining([
					expect.stringContaining("Ignored non-repo path"),
				]),
			);
		} finally {
			await fs.rm(outside, { force: true });
		}
	});

	test("warns and ignores excluded in-repo paths distinctly", async () => {
		const response = await buildWritebackSuggestions(tmpRoot, {
			inspectedFiles: ["node_modules/pkg/index.ts"],
			workSummary: "Confirmed behavior invariant.",
			includeGit: false,
		});

		expect(response.total_suggestions).toBe(0);
		expect(response.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Ignored excluded path"),
			]),
		);
	});
});
