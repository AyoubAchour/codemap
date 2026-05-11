export type SemanticProviderKind = "none" | "local" | "cloud" | "custom";

export interface SemanticRetrievalFileHit {
	file_path: string;
	score: number;
	reason?: string;
}

export interface SemanticRetrievalSearchInput {
	repoRoot: string;
	suitePath: string;
	queryId: string;
	query: string;
	limit: number;
}

export interface SemanticRetrievalAdapter {
	name: string;
	kind: Exclude<SemanticProviderKind, "none">;
	searchFiles(
		input: SemanticRetrievalSearchInput,
	): Promise<SemanticRetrievalFileHit[]>;
}

export interface SemanticRerankCandidate {
	file_path: string;
	score: number;
	content?: string;
}

export interface SemanticRerankInput {
	repoRoot: string;
	suitePath: string;
	queryId: string;
	query: string;
	candidates: SemanticRerankCandidate[];
	limit: number;
}

export interface SemanticRerankAdapter {
	name: string;
	kind: Exclude<SemanticProviderKind, "none">;
	rerankFiles(input: SemanticRerankInput): Promise<SemanticRetrievalFileHit[]>;
}

export interface SemanticRetrievalBenchmarkOptions {
	provider?: "disabled";
	fileAdapter?: SemanticRetrievalAdapter;
}

export interface SemanticRerankBenchmarkOptions {
	provider?: "disabled";
	fileReranker?: SemanticRerankAdapter;
}

export interface ResolvedSemanticRetrieval {
	enabled: boolean;
	provider: string;
	provider_kind: SemanticProviderKind;
	fileAdapter?: SemanticRetrievalAdapter;
}

export interface ResolvedSemanticReranker {
	enabled: boolean;
	provider: string;
	provider_kind: SemanticProviderKind;
	fileReranker?: SemanticRerankAdapter;
}

export interface SemanticRetrievalRun {
	enabled: boolean;
	provider: string;
	provider_kind: SemanticProviderKind;
	latency_ms: number;
	hits: SemanticRetrievalFileHit[];
	warnings: string[];
}

export interface SemanticRerankRun {
	enabled: boolean;
	provider: string;
	provider_kind: SemanticProviderKind;
	latency_ms: number;
	hits: SemanticRetrievalFileHit[];
	warnings: string[];
}

export function resolveSemanticRetrieval(
	options?: SemanticRetrievalBenchmarkOptions,
): ResolvedSemanticRetrieval {
	if (!options?.fileAdapter) {
		return {
			enabled: false,
			provider: "disabled",
			provider_kind: "none",
		};
	}
	return {
		enabled: true,
		provider: options.fileAdapter.name,
		provider_kind: options.fileAdapter.kind,
		fileAdapter: options.fileAdapter,
	};
}

export function resolveSemanticReranker(
	options?: SemanticRerankBenchmarkOptions,
): ResolvedSemanticReranker {
	if (!options?.fileReranker) {
		return {
			enabled: false,
			provider: "disabled",
			provider_kind: "none",
		};
	}
	return {
		enabled: true,
		provider: options.fileReranker.name,
		provider_kind: options.fileReranker.kind,
		fileReranker: options.fileReranker,
	};
}

export async function runSemanticFileRetrieval(
	semantic: ResolvedSemanticRetrieval,
	input: SemanticRetrievalSearchInput,
): Promise<SemanticRetrievalRun> {
	if (!semantic.enabled || !semantic.fileAdapter) {
		return {
			enabled: false,
			provider: semantic.provider,
			provider_kind: semantic.provider_kind,
			latency_ms: 0,
			hits: [],
			warnings: [],
		};
	}

	const startedAt = Date.now();
	const hits = normalizeSemanticHits(
		await semantic.fileAdapter.searchFiles(input),
		input.limit,
	);
	const warnings =
		semantic.provider_kind === "cloud"
			? [
					`Cloud semantic retrieval provider ${semantic.provider} is opt-in; default Codemap benchmark runs remain local-only.`,
				]
			: [];

	return {
		enabled: true,
		provider: semantic.provider,
		provider_kind: semantic.provider_kind,
		latency_ms: Date.now() - startedAt,
		hits,
		warnings,
	};
}

export async function runSemanticRerank(
	reranker: ResolvedSemanticReranker,
	input: SemanticRerankInput,
): Promise<SemanticRerankRun> {
	if (!reranker.enabled || !reranker.fileReranker) {
		return {
			enabled: false,
			provider: reranker.provider,
			provider_kind: reranker.provider_kind,
			latency_ms: 0,
			hits: [],
			warnings: [],
		};
	}

	const startedAt = Date.now();
	const hits = normalizeSemanticHits(
		await reranker.fileReranker.rerankFiles(input),
		input.limit,
	);
	const warnings =
		reranker.provider_kind === "cloud"
			? [
					`Cloud reranker provider ${reranker.provider} is opt-in; default Codemap benchmark runs remain local-only.`,
				]
			: [];

	return {
		enabled: true,
		provider: reranker.provider,
		provider_kind: reranker.provider_kind,
		latency_ms: Date.now() - startedAt,
		hits,
		warnings,
	};
}

function normalizeSemanticHits(
	hits: SemanticRetrievalFileHit[],
	limit: number,
): SemanticRetrievalFileHit[] {
	const seen = new Set<string>();
	const normalized: SemanticRetrievalFileHit[] = [];
	for (const hit of hits) {
		const filePath = normalizeRepoPath(hit.file_path);
		if (filePath.length === 0 || seen.has(filePath)) continue;
		seen.add(filePath);
		normalized.push({
			file_path: filePath,
			score: Number.isFinite(hit.score) ? hit.score : 0,
			reason: hit.reason,
		});
		if (normalized.length >= limit) break;
	}
	return normalized;
}

function normalizeRepoPath(filePath: string): string {
	return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}
