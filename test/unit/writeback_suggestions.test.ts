import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

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
});
