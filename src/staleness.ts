import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { Node } from "./types.js";

export type StaleSourceReason =
	| "changed"
	| "missing"
	| "unsafe_path"
	| "read_error";

export interface StaleSource {
	node_id: string;
	file_path: string;
	stored_hash: string;
	current_hash?: string;
	stale: true;
	reason: StaleSourceReason;
}

export interface StalenessReport {
	checked_sources: number;
	stale_sources: StaleSource[];
}

function safeRepoPath(
	repoRoot: string,
	filePath: string,
): { ok: true; absolutePath: string } | { ok: false } {
	const segments = filePath.split(/[\\/]+/).filter(Boolean);
	if (
		filePath.trim() === "" ||
		path.isAbsolute(filePath) ||
		filePath.includes("\0") ||
		segments.includes("..")
	) {
		return { ok: false };
	}

	const root = path.resolve(repoRoot);
	const absolutePath = path.resolve(root, filePath);
	const relativePath = path.relative(root, absolutePath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		return { ok: false };
	}

	return { ok: true, absolutePath };
}

function sha256(buffer: Buffer): string {
	return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

/**
 * Lazily verify returned query nodes against their source file hashes.
 * This is deliberately read-only: stale knowledge is flagged for the agent,
 * not silently edited or discarded.
 */
export async function checkSourceStaleness(
	repoRoot: string,
	nodes: Node[],
): Promise<StalenessReport> {
	const stale_sources: StaleSource[] = [];
	let checked_sources = 0;

	for (const node of nodes) {
		for (const source of node.sources) {
			checked_sources += 1;
			const safePath = safeRepoPath(repoRoot, source.file_path);
			if (!safePath.ok) {
				stale_sources.push({
					node_id: node.id,
					file_path: source.file_path,
					stored_hash: source.content_hash,
					stale: true,
					reason: "unsafe_path",
				});
				continue;
			}

			let content: Buffer;
			try {
				content = await fs.readFile(safePath.absolutePath);
			} catch (err) {
				stale_sources.push({
					node_id: node.id,
					file_path: source.file_path,
					stored_hash: source.content_hash,
					stale: true,
					reason:
						err instanceof Error &&
						(err as NodeJS.ErrnoException).code === "ENOENT"
							? "missing"
							: "read_error",
				});
				continue;
			}

			const current_hash = sha256(content);
			if (current_hash !== source.content_hash) {
				stale_sources.push({
					node_id: node.id,
					file_path: source.file_path,
					stored_hash: source.content_hash,
					current_hash,
					stale: true,
					reason: "changed",
				});
			}
		}
	}

	return { checked_sources, stale_sources };
}
