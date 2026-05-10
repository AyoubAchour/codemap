import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildRepoMap } from "../../src/repo_map.js";
import { scanSourceIndex } from "../../src/source_index.js";

let tmpRoot: string;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-repo-map-"));
});

afterEach(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function write(filePath: string, content: string): Promise<void> {
	const absolutePath = path.join(tmpRoot, filePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

describe("repo map ranking", () => {
	test("builds deterministic file and symbol rankings from source-index edges", async () => {
		await write(
			"src/db.ts",
			["export function queryDb(id: string) {", "  return { id };", "}"].join(
				"\n",
			),
		);
		await write(
			"src/auth.ts",
			[
				"import { queryDb } from './db';",
				"export function requireActiveUser(id: string) {",
				"  return queryDb(id);",
				"}",
			].join("\n"),
		);
		await write(
			"src/routes.ts",
			[
				"import { requireActiveUser } from './auth';",
				"export function route() {",
				"  return requireActiveUser('u_1');",
				"}",
			].join("\n"),
		);
		await write(
			"test/auth.test.ts",
			[
				"import { requireActiveUser } from '../src/auth';",
				"requireActiveUser('u_1');",
			].join("\n"),
		);

		const index = await scanSourceIndex(tmpRoot);
		const repoMap = buildRepoMap(index, {
			query: "require active user auth",
			fileLimit: 4,
			symbolLimit: 4,
		});

		expect(repoMap.summary).toEqual(
			expect.objectContaining({
				files: 4,
				source_files: 3,
				tests: 1,
			}),
		);
		expect(repoMap.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					from_file: "src/routes.ts",
					to_file: "src/auth.ts",
					kind: "import",
				}),
				expect.objectContaining({
					from_file: "test/auth.test.ts",
					to_file: "src/auth.ts",
					kind: "import",
				}),
			]),
		);
		expect(repoMap.files[0]?.file_path).toBe("src/auth.ts");
		expect(repoMap.files_by_path["src/auth.ts"]).toEqual(
			expect.objectContaining({
				imported_by: 2,
				role: "source",
				top_symbols: expect.arrayContaining([
					expect.objectContaining({ name: "requireActiveUser" }),
				]),
			}),
		);
		expect(repoMap.files_by_path["test/auth.test.ts"]?.role).toBe("test");
		expect(repoMap.symbols[0]).toEqual(
			expect.objectContaining({
				name: "requireActiveUser",
				file_path: "src/auth.ts",
				exported: true,
			}),
		);
	});

	test("seed files boost nearby files for change-oriented context", async () => {
		await write("src/core.ts", "export const CORE_VALUE = 1;\n");
		await write(
			"src/feature.ts",
			"import { CORE_VALUE } from './core';\nexport const feature = CORE_VALUE;\n",
		);

		const index = await scanSourceIndex(tmpRoot);
		const repoMap = buildRepoMap(index, {
			seedFiles: ["src/feature.ts"],
			fileLimit: 2,
		});

		expect(repoMap.files_by_path["src/feature.ts"]?.seed_score).toBe(1);
		expect(repoMap.files_by_path["src/core.ts"]?.seed_score).toBe(0.65);
		expect(repoMap.files.map((file) => file.file_path)).toEqual(
			expect.arrayContaining(["src/feature.ts", "src/core.ts"]),
		);
	});
});
