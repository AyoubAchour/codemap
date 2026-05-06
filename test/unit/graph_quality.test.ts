import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraphStore } from "../../src/graph.js";
import {
	rankGraphResultByQuality,
	summarizeGraphMemoryQuality,
} from "../../src/graph_quality.js";
import { checkSourceStaleness } from "../../src/staleness.js";
import type { Node } from "../../src/types.js";

let tmpRoot: string;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-quality-"));
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

function node(overrides: Partial<Node> & { id: string }): Node {
	const { id, ...rest } = overrides;
	return {
		id,
		kind: "invariant",
		name: "Auth memory",
		summary: "Auth behavior memory for planning.",
		sources: [
			{
				file_path: "src/auth.ts",
				line_range: [1, 1],
				content_hash: "sha256:placeholder",
			},
		],
		tags: ["auth"],
		aliases: [],
		status: "active",
		confidence: 0.9,
		last_verified_at: "2026-05-01T00:00:00Z",
		...rest,
	};
}

describe("graph memory quality", () => {
	test("fresh memory outranks stale memory with the same lexical score", async () => {
		await write("src/fresh.ts", "export const fresh = true;\n");
		await write("src/stale.ts", "export const stale = true;\n");
		const store = await GraphStore.load(tmpRoot);
		store.upsertNode(
			node({
				id: "auth/fresh",
				sources: [
					{
						file_path: "src/fresh.ts",
						line_range: [1, 1],
						content_hash: await fileHash("src/fresh.ts"),
					},
				],
			}),
		);
		store.upsertNode(
			node({
				id: "auth/stale",
				sources: [
					{
						file_path: "src/stale.ts",
						line_range: [1, 1],
						content_hash: "sha256:old",
					},
				],
			}),
		);

		const candidates = store.query("auth", 10);
		const staleness = await checkSourceStaleness(tmpRoot, candidates.nodes);
		const ranked = rankGraphResultByQuality(candidates, staleness, {
			limit: 10,
			now: new Date("2026-05-06T00:00:00Z"),
		});

		expect(ranked.nodes.map((entry) => entry.id)).toEqual([
			"auth/fresh",
			"auth/stale",
		]);
		expect(ranked.matches[0]?.quality).toEqual(
			expect.objectContaining({
				trust: "high",
				freshness: "fresh",
				stale_sources: 0,
			}),
		);
		expect(ranked.matches[1]?.quality).toEqual(
			expect.objectContaining({
				trust: "low",
				freshness: "stale",
				stale_sources: 1,
			}),
		);
	});

	test("lower-confidence memory is demoted but still visible", async () => {
		await write("src/auth.ts", "export const auth = true;\n");
		const hash = await fileHash("src/auth.ts");
		const store = await GraphStore.load(tmpRoot);
		store.upsertNode(
			node({
				id: "auth/high-confidence",
				sources: [
					{ file_path: "src/auth.ts", line_range: [1, 1], content_hash: hash },
				],
				confidence: 0.95,
			}),
		);
		store.upsertNode(
			node({
				id: "auth/low-confidence",
				sources: [
					{ file_path: "src/auth.ts", line_range: [1, 1], content_hash: hash },
				],
				confidence: 0.45,
			}),
		);

		const candidates = store.query("auth", 10);
		const staleness = await checkSourceStaleness(tmpRoot, candidates.nodes);
		const ranked = rankGraphResultByQuality(candidates, staleness, {
			limit: 10,
			now: new Date("2026-05-06T00:00:00Z"),
		});

		expect(ranked.nodes.map((entry) => entry.id)).toEqual([
			"auth/high-confidence",
			"auth/low-confidence",
		]);
		expect(ranked.matches[1]?.quality?.trust).toBe("low");
	});

	test("durable planning kinds outrank file-level memories when other signals match", async () => {
		await write("src/auth.ts", "export const auth = true;\n");
		const hash = await fileHash("src/auth.ts");
		const store = await GraphStore.load(tmpRoot);
		store.upsertNode(
			node({
				id: "auth/file-memory",
				kind: "file",
				sources: [
					{ file_path: "src/auth.ts", line_range: [1, 1], content_hash: hash },
				],
			}),
		);
		store.upsertNode(
			node({
				id: "auth/invariant-memory",
				kind: "invariant",
				sources: [
					{ file_path: "src/auth.ts", line_range: [1, 1], content_hash: hash },
				],
			}),
		);

		const candidates = store.query("auth", 10);
		const staleness = await checkSourceStaleness(tmpRoot, candidates.nodes);
		const ranked = rankGraphResultByQuality(candidates, staleness, {
			limit: 10,
			now: new Date("2026-05-06T00:00:00Z"),
		});

		expect(ranked.nodes.map((entry) => entry.id)).toEqual([
			"auth/invariant-memory",
			"auth/file-memory",
		]);
		expect(ranked.matches[0]?.quality?.factors.kind).toBeGreaterThan(
			ranked.matches[1]?.quality?.factors.kind ?? 0,
		);
	});

	test("summarizes high-trust and review-needed memory ids", async () => {
		await write("src/fresh.ts", "export const fresh = true;\n");
		await write("src/stale.ts", "export const stale = true;\n");
		const store = await GraphStore.load(tmpRoot);
		store.upsertNode(
			node({
				id: "auth/fresh",
				sources: [
					{
						file_path: "src/fresh.ts",
						line_range: [1, 1],
						content_hash: await fileHash("src/fresh.ts"),
					},
				],
			}),
		);
		store.upsertNode(
			node({
				id: "auth/stale",
				sources: [
					{
						file_path: "src/stale.ts",
						line_range: [1, 1],
						content_hash: "sha256:old",
					},
				],
			}),
		);

		const candidates = store.query("auth", 10);
		const staleness = await checkSourceStaleness(tmpRoot, candidates.nodes);
		const ranked = rankGraphResultByQuality(candidates, staleness, {
			limit: 10,
			now: new Date("2026-05-06T00:00:00Z"),
		});

		expect(summarizeGraphMemoryQuality(ranked)).toEqual({
			high_trust_node_ids: ["auth/fresh"],
			review_node_ids: ["auth/stale"],
			stale_node_ids: ["auth/stale"],
			low_trust_node_ids: ["auth/stale"],
		});
	});
});
