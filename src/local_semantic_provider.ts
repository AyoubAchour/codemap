import {
	loadSourceIndex,
	type IndexedSourceFile,
	type SourceIndex,
} from "./source_index.js";
import type {
	SemanticRetrievalAdapter,
	SemanticRetrievalFileHit,
	SemanticRetrievalSearchInput,
} from "./semantic_retrieval.js";
import { normalizeRepoPath } from "./util/repo_path.js";

export const LOCAL_HASH_SEMANTIC_PROVIDER = "local-hash" as const;
export type LocalHashSemanticProvider = typeof LOCAL_HASH_SEMANTIC_PROVIDER;

const VECTOR_DIMENSIONS = 512;
const MAX_FILE_TEXT_CHARS = 120_000;
const FILE_VECTOR_CACHE_MAX_ENTRIES = 4;
const TOKEN_WEIGHT = 1.2;
const BIGRAM_WEIGHT = 0.75;
const NGRAM_WEIGHT = 0.25;

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"be",
	"by",
	"for",
	"from",
	"how",
	"in",
	"into",
	"is",
	"it",
	"of",
	"on",
	"or",
	"should",
	"that",
	"the",
	"this",
	"to",
	"what",
	"when",
	"with",
	"without",
]);

const CODE_STOP_WORDS = new Set([
	"async",
	"await",
	"const",
	"export",
	"false",
	"function",
	"import",
	"interface",
	"let",
	"return",
	"string",
	"true",
	"type",
]);

interface WeightedText {
	text: string;
	weight: number;
}

interface SparseVector {
	weights: Map<number, number>;
	magnitude: number;
}

interface FileVector {
	file_path: string;
	vector: SparseVector;
}

const fileVectorCache = new Map<string, FileVector[]>();

export function createLocalHashSemanticAdapter(): SemanticRetrievalAdapter {
	return {
		name: LOCAL_HASH_SEMANTIC_PROVIDER,
		kind: "local",
		searchFiles: runLocalHashSemanticRetrieval,
	};
}

export async function runLocalHashSemanticRetrieval(
	input: SemanticRetrievalSearchInput,
): Promise<SemanticRetrievalFileHit[]> {
	const index = await loadSourceIndex(input.repoRoot);
	if (!index) return [];

	const queryVector = embedWeightedText([{ text: input.query, weight: 1 }]);
	if (queryVector.magnitude === 0) return [];

	const fileVectors = cachedFileVectors(input.repoRoot, index);
	return fileVectors
		.map((file) => ({
			file_path: file.file_path,
			score: cosineSimilarity(queryVector, file.vector),
			reason:
				"local hash-vector similarity over source-index path, symbols, imports, exports, and text",
		}))
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score || a.file_path.localeCompare(b.file_path))
		.slice(0, input.limit)
		.map((hit) => ({
			...hit,
			score: round4(hit.score),
		}));
}

function cachedFileVectors(repoRoot: string, index: SourceIndex): FileVector[] {
	const cacheKey = [
		normalizeRepoPath(repoRoot),
		index.updated_at,
		index.stats.files_indexed,
		index.stats.chunks_indexed,
	].join("|");
	const cached = fileVectorCache.get(cacheKey);
	if (cached) return cached;

	const vectors = Object.values(index.files).map(vectorizeFile);
	fileVectorCache.set(cacheKey, vectors);
	while (fileVectorCache.size > FILE_VECTOR_CACHE_MAX_ENTRIES) {
		const oldestKey = fileVectorCache.keys().next().value;
		if (oldestKey === undefined) break;
		fileVectorCache.delete(oldestKey);
	}
	return vectors;
}

function vectorizeFile(file: IndexedSourceFile): FileVector {
	const filePath = normalizeRepoPath(file.file_path);
	const symbolText = file.symbols.map((symbol) => symbol.name).join(" ");
	const importText = file.imports.map((sourceImport) => sourceImport.module).join(" ");
	const chunkText = file.chunks
		.map((chunk) => chunk.content)
		.join("\n")
		.slice(0, MAX_FILE_TEXT_CHARS);
	return {
		file_path: filePath,
		vector: embedWeightedText([
			{ text: filePath.replace(/[\\/_.-]+/g, " "), weight: 4 },
			{ text: `${file.exports.join(" ")} ${symbolText} ${importText}`, weight: 3 },
			{ text: chunkText, weight: 1 },
		]),
	};
}

function embedWeightedText(sections: WeightedText[]): SparseVector {
	const weights = new Map<number, number>();
	for (const section of sections) {
		const tokens = tokenize(section.text);
		for (let index = 0; index < tokens.length; index += 1) {
			const token = stemToken(tokens[index] ?? "");
			if (token.length === 0) continue;
			addFeature(weights, `tok:${token}`, TOKEN_WEIGHT * section.weight);
			for (const ngram of characterNgrams(token)) {
				addFeature(weights, `ng:${ngram}`, NGRAM_WEIGHT * section.weight);
			}
			const next = stemToken(tokens[index + 1] ?? "");
			if (next.length > 0) {
				addFeature(weights, `bi:${token}:${next}`, BIGRAM_WEIGHT * section.weight);
			}
		}
	}
	return {
		weights,
		magnitude: vectorMagnitude(weights),
	};
}

function tokenize(text: string): string[] {
	return splitIdentifierText(text)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter((token) => isUsefulToken(token));
}

function splitIdentifierText(text: string): string {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function isUsefulToken(token: string): boolean {
	if (token.length < 2) return false;
	if (STOP_WORDS.has(token) || CODE_STOP_WORDS.has(token)) return false;
	return true;
}

function stemToken(token: string): string {
	if (token.length > 5 && token.endsWith("ies")) {
		return `${token.slice(0, -3)}y`;
	}
	for (const suffix of ["ing", "ed", "es", "s"]) {
		if (token.length > suffix.length + 3 && token.endsWith(suffix)) {
			return token.slice(0, -suffix.length);
		}
	}
	return token;
}

function characterNgrams(token: string): string[] {
	const padded = ` ${token} `;
	const ngrams: string[] = [];
	for (const size of [3, 4]) {
		if (padded.length < size) continue;
		for (let index = 0; index <= padded.length - size; index += 1) {
			ngrams.push(padded.slice(index, index + size));
		}
	}
	return ngrams;
}

function addFeature(
	weights: Map<number, number>,
	feature: string,
	weight: number,
): void {
	const bucket = hashFeature(feature) % VECTOR_DIMENSIONS;
	weights.set(bucket, (weights.get(bucket) ?? 0) + weight);
}

function hashFeature(feature: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < feature.length; index += 1) {
		hash ^= feature.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function vectorMagnitude(weights: Map<number, number>): number {
	let sum = 0;
	for (const weight of weights.values()) {
		sum += weight * weight;
	}
	return Math.sqrt(sum);
}

function cosineSimilarity(a: SparseVector, b: SparseVector): number {
	if (a.magnitude === 0 || b.magnitude === 0) return 0;
	const [smaller, larger] =
		a.weights.size <= b.weights.size ? [a.weights, b.weights] : [b.weights, a.weights];
	let dot = 0;
	for (const [bucket, weight] of smaller) {
		dot += weight * (larger.get(bucket) ?? 0);
	}
	return dot / (a.magnitude * b.magnitude);
}

function round4(value: number): number {
	return Number(value.toFixed(4));
}
