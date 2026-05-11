import * as path from "node:path";

import type {
	IndexedSourceFile,
	SourceImport,
	SourceIndex,
	SourceSymbol,
} from "./source_index.js";

export type RepoMapFileRole = "source" | "test" | "doc";
export type RepoMapEdgeKind = "import" | "reference";

export interface RepoMapEdge {
	from_file: string;
	to_file: string;
	kind: RepoMapEdgeKind;
	weight: number;
	reason: string;
}

export interface RepoMapFileRank {
	file_path: string;
	area: string;
	role: RepoMapFileRole;
	rank: number;
	centrality: number;
	query_score: number;
	seed_score: number;
	imports: number;
	imported_by: number;
	symbols: number;
	exported_symbols: number;
	references: number;
	top_symbols: SourceSymbol[];
	reasons: string[];
}

export interface RepoMapFileSummary {
	file_path: string;
	area: string;
	role: RepoMapFileRole;
	rank: number;
	centrality: number;
	imported_by: number;
	symbols: number;
	top_symbols: string[];
	reasons: string[];
}

export interface RepoMapSymbolRank {
	name: string;
	kind: SourceSymbol["kind"];
	file_path: string;
	line: number;
	exported: boolean;
	rank: number;
	references: number;
	reasons: string[];
}

export interface RepoMapSummary {
	files: number;
	edges: number;
	symbols: number;
	tests: number;
	docs: number;
	source_files: number;
}

export interface RepoMap {
	summary: RepoMapSummary;
	files: RepoMapFileRank[];
	symbols: RepoMapSymbolRank[];
	edges: RepoMapEdge[];
	files_by_path: Record<string, RepoMapFileRank>;
}

export interface BuildRepoMapOptions {
	query?: string;
	seedFiles?: string[];
	fileLimit?: number;
	symbolLimit?: number;
}

interface MutableEdge {
	from_file: string;
	to_file: string;
	kind: RepoMapEdgeKind;
	weight: number;
	reasons: Set<string>;
}

const RESOLVABLE_EXTENSIONS = [
	".cjs",
	".cts",
	".js",
	".jsx",
	".mjs",
	".mts",
	".ts",
	".tsx",
];
const DEFAULT_FILE_LIMIT = 10;
const DEFAULT_SYMBOL_LIMIT = 20;
const PAGERANK_DAMPING = 0.85;
const PAGERANK_ITERATIONS = 24;

export function buildRepoMap(
	index: SourceIndex | null,
	options: BuildRepoMapOptions = {},
): RepoMap {
	const files = Object.values(index?.files ?? {}).sort((a, b) =>
		a.file_path.localeCompare(b.file_path),
	);
	if (files.length === 0) {
		return {
			summary: {
				files: 0,
				edges: 0,
				symbols: 0,
				tests: 0,
				docs: 0,
				source_files: 0,
			},
			files: [],
			symbols: [],
			edges: [],
			files_by_path: {},
		};
	}

	const fileMap = new Map(files.map((file) => [file.file_path, file] as const));
	const edgeMap = new Map<string, MutableEdge>();
	const importedByCount = new Map<string, number>();
	const importsCount = new Map<string, number>();
	const symbolReferenceCounts = new Map<string, number>();

	for (const file of files) {
		for (const sourceImport of file.imports) {
			const resolved = resolveIndexedImportPath(
				fileMap,
				file.file_path,
				sourceImport.module,
			);
			if (!resolved || resolved === file.file_path) continue;
			addEdge(edgeMap, {
				from_file: file.file_path,
				to_file: resolved,
				kind: "import",
				weight: 3,
				reason: `imports ${sourceImport.module}`,
			});
			importsCount.set(
				file.file_path,
				(importsCount.get(file.file_path) ?? 0) + 1,
			);
			importedByCount.set(resolved, (importedByCount.get(resolved) ?? 0) + 1);
		}
	}

	const exportedSymbolsByName = new Map<string, SourceSymbol[]>();
	for (const file of files) {
		for (const symbol of file.symbols.filter((entry) => entry.exported)) {
			const current = exportedSymbolsByName.get(symbol.name) ?? [];
			current.push(symbol);
			exportedSymbolsByName.set(symbol.name, current);
		}
	}

	const filesBySymbolObject = new Map<SourceSymbol, string>();
	for (const file of files) {
		for (const symbol of file.symbols) {
			filesBySymbolObject.set(symbol, file.file_path);
		}
	}

	for (const file of files) {
		const uniqueReferenceNames = new Set(
			(file.references ?? []).map((reference) => reference.name),
		);
		for (const name of uniqueReferenceNames) {
			const targets = exportedSymbolsByName.get(name) ?? [];
			for (const target of targets) {
				const targetFile = filesBySymbolObject.get(target);
				if (!targetFile || targetFile === file.file_path) continue;
				addEdge(edgeMap, {
					from_file: file.file_path,
					to_file: targetFile,
					kind: "reference",
					weight: 1,
					reason: `references ${name}`,
				});
				const key = symbolKey(targetFile, target);
				symbolReferenceCounts.set(
					key,
					(symbolReferenceCounts.get(key) ?? 0) + 1,
				);
			}
		}
	}

	const edges = [...edgeMap.values()]
		.map((edge) => ({
			from_file: edge.from_file,
			to_file: edge.to_file,
			kind: edge.kind,
			weight: Number(edge.weight.toFixed(4)),
			reason: [...edge.reasons].sort().slice(0, 3).join("; "),
		}))
		.sort(edgeSort);
	const centralityByFile = pageRank(
		files.map((file) => file.file_path),
		edges,
	);
	const queryTokens = tokensFor(options.query ?? "");
	const seedFiles = new Set(options.seedFiles ?? []);
	const seedAdjacentFiles = seedAdjacentFilesFor(seedFiles, edges);

	const rankedFiles = files
		.map((file) => {
			const centrality = centralityByFile.get(file.file_path) ?? 0;
			const queryScore =
				queryTokens.length > 0 ? queryRelevance(file, queryTokens) : 0;
			const seedScore = seedRelevance(file, seedFiles, seedAdjacentFiles);
			const rank = combinedFileRank(centrality, queryScore, seedScore);
			const topSymbols = topSymbolsForFile(file, symbolReferenceCounts);
			return {
				file_path: file.file_path,
				area: areaNameForPath(file.file_path),
				role: roleForPath(file.file_path),
				rank,
				centrality,
				query_score: queryScore,
				seed_score: seedScore,
				imports: importsCount.get(file.file_path) ?? 0,
				imported_by: importedByCount.get(file.file_path) ?? 0,
				symbols: file.symbols.length,
				exported_symbols: file.symbols.filter((symbol) => symbol.exported)
					.length,
				references: file.references?.length ?? 0,
				top_symbols: topSymbols,
				reasons: fileReasons({
					file,
					centrality,
					queryScore,
					seedScore,
					importedBy: importedByCount.get(file.file_path) ?? 0,
					imports: importsCount.get(file.file_path) ?? 0,
				}),
			} satisfies RepoMapFileRank;
		})
		.sort(fileRankSort);

	const fileRankByPath = new Map(
		rankedFiles.map((file) => [file.file_path, file] as const),
	);
	const rankedSymbols = files
		.flatMap((file) =>
			file.symbols.map((symbol) => {
				const references =
					symbolReferenceCounts.get(symbolKey(file.file_path, symbol)) ?? 0;
				const fileRank = fileRankByPath.get(file.file_path)?.rank ?? 0;
				const rank = round4(
					fileRank * 0.7 +
						Math.min(1, references / 5) * 0.2 +
						(symbol.exported ? 0.1 : 0),
				);
				return {
					name: symbol.name,
					kind: symbol.kind,
					file_path: file.file_path,
					line: symbol.name_line ?? symbol.line,
					exported: symbol.exported,
					rank,
					references,
					reasons: symbolReasons(symbol, references, fileRank),
				} satisfies RepoMapSymbolRank;
			}),
		)
		.sort(symbolRankSort);

	const fileLimit = options.fileLimit ?? DEFAULT_FILE_LIMIT;
	const symbolLimit = options.symbolLimit ?? DEFAULT_SYMBOL_LIMIT;
	const summary = {
		files: files.length,
		edges: edges.length,
		symbols: files.reduce((sum, file) => sum + file.symbols.length, 0),
		tests: files.filter((file) => roleForPath(file.file_path) === "test")
			.length,
		docs: files.filter((file) => roleForPath(file.file_path) === "doc").length,
		source_files: files.filter(
			(file) => roleForPath(file.file_path) === "source",
		).length,
	};

	return {
		summary,
		files: rankedFiles.slice(0, fileLimit),
		symbols: rankedSymbols.slice(0, symbolLimit),
		edges,
		files_by_path: Object.fromEntries(
			rankedFiles.map((file) => [file.file_path, file]),
		),
	};
}

export function repoMapFileSummary(file: RepoMapFileRank): RepoMapFileSummary {
	return {
		file_path: file.file_path,
		area: file.area,
		role: file.role,
		rank: file.rank,
		centrality: file.centrality,
		imported_by: file.imported_by,
		symbols: file.symbols,
		top_symbols: file.top_symbols.slice(0, 3).map((symbol) => symbol.name),
		reasons: file.reasons.slice(0, 3),
	};
}

function addEdge(edgeMap: Map<string, MutableEdge>, edge: RepoMapEdge): void {
	const key = `${edge.from_file}\0${edge.to_file}\0${edge.kind}`;
	const existing = edgeMap.get(key);
	if (existing) {
		existing.weight += edge.weight;
		existing.reasons.add(edge.reason);
		return;
	}
	edgeMap.set(key, {
		from_file: edge.from_file,
		to_file: edge.to_file,
		kind: edge.kind,
		weight: edge.weight,
		reasons: new Set([edge.reason]),
	});
}

function pageRank(
	filePaths: string[],
	edges: RepoMapEdge[],
): Map<string, number> {
	const count = filePaths.length;
	const initialRank = 1 / count;
	const outgoing = new Map<string, Array<{ to: string; weight: number }>>();
	for (const filePath of filePaths) outgoing.set(filePath, []);
	for (const edge of edges) {
		outgoing.get(edge.from_file)?.push({
			to: edge.to_file,
			weight: edge.weight,
		});
	}

	let ranks = new Map(
		filePaths.map((filePath) => [filePath, initialRank] as const),
	);
	for (let iteration = 0; iteration < PAGERANK_ITERATIONS; iteration += 1) {
		const next = new Map(
			filePaths.map(
				(filePath) => [filePath, (1 - PAGERANK_DAMPING) / count] as const,
			),
		);
		let sinkRank = 0;
		for (const filePath of filePaths) {
			const rank = ranks.get(filePath) ?? 0;
			const targets = outgoing.get(filePath) ?? [];
			const totalWeight = targets.reduce(
				(sum, target) => sum + target.weight,
				0,
			);
			if (targets.length === 0 || totalWeight <= 0) {
				sinkRank += rank;
				continue;
			}
			for (const target of targets) {
				next.set(
					target.to,
					(next.get(target.to) ?? 0) +
						PAGERANK_DAMPING * rank * (target.weight / totalWeight),
				);
			}
		}
		const sinkContribution = (PAGERANK_DAMPING * sinkRank) / count;
		for (const filePath of filePaths) {
			next.set(filePath, (next.get(filePath) ?? 0) + sinkContribution);
		}
		ranks = next;
	}

	let maxRank = 0;
	for (const rank of ranks.values()) {
		if (rank > maxRank) maxRank = rank;
	}
	return new Map(
		[...ranks.entries()].map(([filePath, rank]) => [
			filePath,
			round4(maxRank > 0 ? rank / maxRank : 0),
		]),
	);
}

function queryRelevance(
	file: IndexedSourceFile,
	queryTokens: string[],
): number {
	if (queryTokens.length === 0) return 0;
	const words = new Set([
		...tokensFor(file.file_path),
		...file.imports.flatMap((entry) => tokensFor(entry.module)),
		...file.exports.flatMap((entry) => tokensFor(entry)),
		...file.symbols.flatMap((entry) => tokensFor(entry.name)),
	]);
	let score = 0;
	for (const token of queryTokens) {
		if (words.has(token)) score += 1;
	}
	return round4(Math.min(1, score / queryTokens.length));
}

function seedRelevance(
	file: IndexedSourceFile,
	seedFiles: Set<string>,
	seedAdjacentFiles: Set<string>,
): number {
	if (seedFiles.size === 0) return 0;
	if (seedFiles.has(file.file_path)) return 1;
	return seedAdjacentFiles.has(file.file_path) ? 0.65 : 0;
}

function seedAdjacentFilesFor(
	seedFiles: Set<string>,
	edges: RepoMapEdge[],
): Set<string> {
	const adjacent = new Set<string>();
	if (seedFiles.size === 0) return adjacent;
	for (const edge of edges) {
		if (seedFiles.has(edge.from_file)) adjacent.add(edge.to_file);
		if (seedFiles.has(edge.to_file)) adjacent.add(edge.from_file);
	}
	return adjacent;
}

function combinedFileRank(
	centrality: number,
	queryScore: number,
	seedScore: number,
): number {
	return round4(centrality * 0.68 + queryScore * 0.24 + seedScore * 0.08);
}

function topSymbolsForFile(
	file: IndexedSourceFile,
	symbolReferenceCounts: Map<string, number>,
): SourceSymbol[] {
	return file.symbols
		.slice()
		.sort(
			(a, b) =>
				Number(b.exported) - Number(a.exported) ||
				(symbolReferenceCounts.get(symbolKey(file.file_path, b)) ?? 0) -
					(symbolReferenceCounts.get(symbolKey(file.file_path, a)) ?? 0) ||
				(a.name_line ?? a.line) - (b.name_line ?? b.line) ||
				a.name.localeCompare(b.name),
		)
		.slice(0, 5);
}

function fileReasons(input: {
	file: IndexedSourceFile;
	centrality: number;
	queryScore: number;
	seedScore: number;
	importedBy: number;
	imports: number;
}): string[] {
	const reasons: string[] = [];
	if (input.centrality > 0.75) reasons.push("high PageRank centrality");
	if (input.queryScore > 0) reasons.push("matches query terms");
	if (input.seedScore > 0) reasons.push("near changed or seed files");
	if (input.importedBy > 0)
		reasons.push(`imported by ${input.importedBy} file(s)`);
	if (input.imports > 0) reasons.push(`imports ${input.imports} local file(s)`);
	if (input.file.symbols.some((symbol) => symbol.exported)) {
		reasons.push("defines exported symbols");
	}
	return reasons.length > 0 ? reasons : ["indexed source file"];
}

function symbolReasons(
	symbol: SourceSymbol,
	references: number,
	fileRank: number,
): string[] {
	const reasons: string[] = [];
	if (symbol.exported) reasons.push("exported");
	if (references > 0) reasons.push(`referenced by ${references} file(s)`);
	if (fileRank > 0.75) reasons.push("defined in high-rank file");
	return reasons.length > 0 ? reasons : ["indexed symbol"];
}

function resolveIndexedImportPath(
	files: Map<string, IndexedSourceFile>,
	fromFilePath: string,
	moduleSpecifier: SourceImport["module"],
): string | null {
	if (!moduleSpecifier.startsWith(".")) return null;

	const baseDir = path.posix.dirname(fromFilePath);
	const unresolved = path.posix.normalize(
		path.posix.join(baseDir, moduleSpecifier),
	);
	if (unresolved.startsWith("../") || path.posix.isAbsolute(unresolved)) {
		return null;
	}

	const explicitExtension = path.posix.extname(unresolved);
	const baseWithoutExtension = explicitExtension
		? unresolved.slice(0, -explicitExtension.length)
		: unresolved;
	const candidates = [
		unresolved,
		...RESOLVABLE_EXTENSIONS.map((extension) => `${unresolved}${extension}`),
		...(explicitExtension
			? RESOLVABLE_EXTENSIONS.map(
					(extension) => `${baseWithoutExtension}${extension}`,
				)
			: []),
		...RESOLVABLE_EXTENSIONS.map(
			(extension) => `${unresolved}/index${extension}`,
		),
		...(explicitExtension
			? RESOLVABLE_EXTENSIONS.map(
					(extension) => `${baseWithoutExtension}/index${extension}`,
				)
			: []),
	];

	return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function roleForPath(filePath: string): RepoMapFileRole {
	if (
		/\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath) ||
		/(^|\/)(test|tests|__tests__)\//.test(filePath)
	) {
		return "test";
	}
	if (/\.(md|mdx|rst|txt)$/.test(filePath) || /(^|\/)docs?\//.test(filePath)) {
		return "doc";
	}
	return "source";
}

function areaNameForPath(filePath: string): string {
	return filePath.includes("/") ? (filePath.split("/")[0] ?? filePath) : "root";
}

function tokensFor(value: string): string[] {
	const expanded = value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[-_./\\]+/g, " ");
	const direct = value.toLowerCase().replace(/[^a-z0-9$]+/g, "");
	return [
		direct,
		...expanded
			.toLowerCase()
			.split(/[^a-z0-9$]+/)
			.filter((token) => token.length >= 2),
	].filter((token, index, all) => token && all.indexOf(token) === index);
}

function symbolKey(filePath: string, symbol: SourceSymbol): string {
	return `${filePath}:${symbol.name}:${symbol.name_line ?? symbol.line}:${symbol.kind}`;
}

function edgeSort(a: RepoMapEdge, b: RepoMapEdge): number {
	return (
		b.weight - a.weight ||
		a.from_file.localeCompare(b.from_file) ||
		a.to_file.localeCompare(b.to_file) ||
		a.kind.localeCompare(b.kind)
	);
}

function fileRankSort(a: RepoMapFileRank, b: RepoMapFileRank): number {
	return (
		b.rank - a.rank ||
		b.centrality - a.centrality ||
		b.imported_by - a.imported_by ||
		a.file_path.localeCompare(b.file_path)
	);
}

function symbolRankSort(a: RepoMapSymbolRank, b: RepoMapSymbolRank): number {
	return (
		b.rank - a.rank ||
		b.references - a.references ||
		Number(b.exported) - Number(a.exported) ||
		a.file_path.localeCompare(b.file_path) ||
		a.line - b.line ||
		a.name.localeCompare(b.name)
	);
}

function round4(value: number): number {
	return Number(value.toFixed(4));
}
