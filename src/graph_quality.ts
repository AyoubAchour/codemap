import type { QueryResult } from "./graph.js";
import type { StalenessReport } from "./staleness.js";
import type {
	Edge,
	Node,
	NodeKind,
	NodeMaturity,
	NodeQualityMetadata,
} from "./types.js";

export type GraphMemoryFreshness =
	| "fresh"
	| "no_sources"
	| "stale"
	| "unchecked";

export type GraphMemoryTrust = "high" | "medium" | "low";

export interface GraphMemoryQuality {
	score: number;
	trust: GraphMemoryTrust;
	freshness: GraphMemoryFreshness;
	confidence: number;
	age_days: number | null;
	checked_sources: number;
	stale_sources: number;
	signals: {
		utility_score: number | null;
		maturity: NodeMaturity | "unset";
		last_used_at: string | null;
		days_since_used: number | null;
		confirmed_by_source: boolean | null;
		superseded_by: string | null;
	};
	factors: {
		confidence: number;
		source_freshness: number;
		verification_age: number;
		kind: number;
		status: number;
		utility: number;
		maturity: number;
		usage_recency: number;
		source_confirmation: number;
	};
	reasons: string[];
}

export interface GraphMemoryQualitySummary {
	high_trust_node_ids: string[];
	review_node_ids: string[];
	stale_node_ids: string[];
	low_trust_node_ids: string[];
}

export interface RankGraphQualityOptions {
	limit: number;
	now?: Date;
	sourceChecksEnabled?: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function rankGraphResultByQuality(
	result: QueryResult,
	staleness: StalenessReport,
	options: RankGraphQualityOptions,
): QueryResult {
	const matchById = new Map(
		result.matches.map((match) => [match.node_id, match]),
	);
	const sourceChecksEnabled = options.sourceChecksEnabled ?? true;
	const scored = result.nodes.map((node) => {
		const match = matchById.get(node.id) ?? {
			node_id: node.id,
			score: 0,
			score_breakdown: { alias: 0, name: 0, summary: 0, tag: 0 },
			match_reasons: [],
		};
		const quality = scoreGraphMemoryQuality(node, staleness, {
			now: options.now,
			sourceChecksEnabled,
		});
		return {
			node,
			match,
			quality,
			rankingScore: graphMemoryRankingScore(match.score, quality),
		};
	});

	scored.sort(
		(a, b) =>
			b.rankingScore - a.rankingScore ||
			b.match.score - a.match.score ||
			b.quality.score - a.quality.score ||
			a.node.id.localeCompare(b.node.id),
	);

	const top = scored.slice(0, options.limit);
	const topIds = new Set(top.map((entry) => entry.node.id));

	return {
		nodes: top.map((entry) => entry.node),
		matches: top.map((entry) => ({
			...entry.match,
			ranking_score: entry.rankingScore,
			quality: entry.quality,
		})),
		edges: filterEdges(result.edges, topIds),
	};
}

export function filterStalenessReportForNodes(
	staleness: StalenessReport,
	nodes: Node[],
	sourceChecksEnabled = true,
): StalenessReport {
	if (!sourceChecksEnabled) {
		return { checked_sources: 0, stale_sources: [], range_fresh_sources: [] };
	}
	const nodeIds = new Set(nodes.map((node) => node.id));
	return {
		checked_sources: nodes.reduce((sum, node) => sum + node.sources.length, 0),
		stale_sources: staleness.stale_sources.filter((source) =>
			nodeIds.has(source.node_id),
		),
		range_fresh_sources: staleness.range_fresh_sources.filter((source) =>
			nodeIds.has(source.node_id),
		),
	};
}

export function summarizeGraphMemoryQuality(
	result: QueryResult,
): GraphMemoryQualitySummary {
	const qualityById = new Map<string, GraphMemoryQuality>();
	for (const match of result.matches) {
		if (match.quality) {
			qualityById.set(match.node_id, match.quality);
		}
	}
	const high_trust_node_ids: string[] = [];
	const review_node_ids: string[] = [];
	const stale_node_ids: string[] = [];
	const low_trust_node_ids: string[] = [];

	for (const node of result.nodes) {
		const quality = qualityById.get(node.id);
		if (!quality) continue;
		if (quality.trust === "high") {
			high_trust_node_ids.push(node.id);
		} else if (quality.trust === "medium") {
			review_node_ids.push(node.id);
		}
		if (quality.freshness === "stale") {
			stale_node_ids.push(node.id);
		}
		if (quality.trust === "low") {
			low_trust_node_ids.push(node.id);
		}
	}

	return {
		high_trust_node_ids,
		review_node_ids,
		stale_node_ids,
		low_trust_node_ids,
	};
}

export function scoreGraphMemoryQuality(
	node: Node,
	staleness: StalenessReport,
	options: { now?: Date; sourceChecksEnabled?: boolean } = {},
): GraphMemoryQuality {
	const now = options.now ?? new Date();
	const sourceChecksEnabled = options.sourceChecksEnabled ?? true;
	const staleSources = staleness.stale_sources.filter(
		(source) => source.node_id === node.id,
	).length;
	const checkedSources = sourceChecksEnabled ? node.sources.length : 0;
	const freshness = graphMemoryFreshness({
		checkedSources,
		sourceChecksEnabled,
		staleSources,
	});
	const ageDays = daysSinceVerification(node.last_verified_at, now);
	const metadata = node.quality;
	const daysSinceUsed = daysSinceLastUsed(metadata?.last_used_at, now);
	const signals = {
		utility_score: metadata?.utility_score ?? null,
		maturity: metadata?.maturity ?? ("unset" as const),
		last_used_at: metadata?.last_used_at ?? null,
		days_since_used: daysSinceUsed === null ? null : Math.round(daysSinceUsed),
		confirmed_by_source: metadata?.confirmed_by_source ?? null,
		superseded_by: metadata?.superseded_by ?? null,
	};
	const factors = {
		confidence: clamp01(node.confidence),
		source_freshness: sourceFreshnessFactor(
			freshness,
			staleSources,
			checkedSources,
		),
		verification_age: verificationAgeFactor(ageDays),
		kind: kindFactor(node.kind),
		status: node.status === "deprecated" ? 0.35 : 1,
		utility: utilityFactor(metadata?.utility_score),
		maturity: maturityFactor(metadata?.maturity, metadata?.superseded_by),
		usage_recency: usageRecencyFactor(daysSinceUsed),
		source_confirmation: sourceConfirmationFactor(
			metadata?.confirmed_by_source,
			freshness,
		),
	};
	const score = round4(
		factors.confidence * 0.24 +
			factors.source_freshness * 0.2 +
			factors.verification_age * 0.14 +
			factors.kind * 0.08 +
			factors.status * 0.08 +
			factors.utility * 0.1 +
			factors.maturity * 0.07 +
			factors.usage_recency * 0.04 +
			factors.source_confirmation * 0.05,
	);
	const trust = trustTier({
		score,
		confidence: factors.confidence,
		freshness,
		status: node.status,
		metadata,
	});

	return {
		score,
		trust,
		freshness,
		confidence: node.confidence,
		age_days: ageDays === null ? null : Math.round(ageDays),
		checked_sources: checkedSources,
		stale_sources: staleSources,
		signals,
		factors,
		reasons: qualityReasons({
			node,
			metadata,
			freshness,
			staleSources,
			checkedSources,
			ageDays,
			daysSinceUsed,
			trust,
		}),
	};
}

function graphMemoryRankingScore(
	lexicalScore: number,
	quality: GraphMemoryQuality,
): number {
	return round4(lexicalScore * (0.35 + quality.score));
}

function graphMemoryFreshness(input: {
	checkedSources: number;
	sourceChecksEnabled: boolean;
	staleSources: number;
}): GraphMemoryFreshness {
	if (!input.sourceChecksEnabled) return "unchecked";
	if (input.checkedSources === 0) return "no_sources";
	if (input.staleSources > 0) return "stale";
	return "fresh";
}

function sourceFreshnessFactor(
	freshness: GraphMemoryFreshness,
	staleSources: number,
	checkedSources: number,
): number {
	if (freshness === "fresh") return 1;
	if (freshness === "unchecked") return 0.78;
	if (freshness === "no_sources") return 0.62;
	const staleRatio = staleSources / checkedSources;
	return clamp(1 - staleRatio * 0.7, 0.3, 0.75);
}

function verificationAgeFactor(ageDays: number | null): number {
	if (ageDays === null) return 0.72;
	if (ageDays <= 30) return 1;
	if (ageDays <= 180) return 0.92;
	if (ageDays <= 365) return 0.82;
	if (ageDays <= 730) return 0.72;
	return 0.62;
}

function utilityFactor(utilityScore: number | undefined): number {
	if (utilityScore === undefined) return 0.72;
	return clamp01(utilityScore);
}

function maturityFactor(
	maturity: NodeMaturity | undefined,
	supersededBy: string | undefined,
): number {
	if (supersededBy) return 0.2;
	switch (maturity) {
		case "stable":
			return 1;
		case "confirmed":
			return 0.92;
		case "draft":
			return 0.72;
		case "superseded":
			return 0.2;
		case undefined:
			return 0.82;
	}
}

function usageRecencyFactor(daysSinceUsed: number | null): number {
	if (daysSinceUsed === null) return 0.82;
	if (daysSinceUsed <= 30) return 1;
	if (daysSinceUsed <= 180) return 0.92;
	if (daysSinceUsed <= 365) return 0.84;
	return 0.72;
}

function sourceConfirmationFactor(
	confirmedBySource: boolean | undefined,
	freshness: GraphMemoryFreshness,
): number {
	if (confirmedBySource === true) return 1;
	if (confirmedBySource === false) return 0.68;
	return freshness === "fresh" ? 0.9 : 0.78;
}

function kindFactor(kind: NodeKind): number {
	switch (kind) {
		case "decision":
		case "gotcha":
		case "invariant":
			return 1;
		case "flow":
			return 0.95;
		case "concept":
		case "integration":
			return 0.9;
		case "package":
		case "symbol":
			return 0.85;
		case "file":
			return 0.8;
	}
}

function trustTier(input: {
	score: number;
	confidence: number;
	freshness: GraphMemoryFreshness;
	status: Node["status"];
	metadata?: NodeQualityMetadata;
}): GraphMemoryTrust {
	if (
		input.status === "deprecated" ||
		input.metadata?.maturity === "superseded" ||
		input.metadata?.superseded_by !== undefined ||
		input.freshness === "stale" ||
		input.confidence < 0.55 ||
		(input.metadata?.utility_score !== undefined &&
			input.metadata.utility_score <= 0.25) ||
		input.score < 0.62
	) {
		return "low";
	}
	if (
		input.freshness === "fresh" &&
		input.confidence >= 0.8 &&
		(input.metadata?.utility_score ?? 0.8) >= 0.55 &&
		input.metadata?.maturity !== "draft" &&
		input.score >= 0.82
	) {
		return "high";
	}
	return "medium";
}

function qualityReasons(input: {
	node: Node;
	metadata?: NodeQualityMetadata;
	freshness: GraphMemoryFreshness;
	staleSources: number;
	checkedSources: number;
	ageDays: number | null;
	daysSinceUsed: number | null;
	trust: GraphMemoryTrust;
}): string[] {
	const reasons: string[] = [];
	reasons.push(`confidence ${input.node.confidence.toFixed(2)}`);
	if (input.freshness === "fresh") {
		reasons.push("source anchors are fresh");
	} else if (input.freshness === "stale") {
		reasons.push(
			`${input.staleSources} of ${input.checkedSources} source anchors are stale`,
		);
	} else if (input.freshness === "no_sources") {
		reasons.push("no source anchors to verify");
	} else {
		reasons.push("source anchors were not checked");
	}

	if (input.ageDays === null) {
		reasons.push("verification timestamp could not be aged");
	} else if (input.ageDays <= 30) {
		reasons.push("verified recently");
	} else {
		reasons.push(`verified ${Math.round(input.ageDays)} days ago`);
	}

	if (input.metadata?.utility_score !== undefined) {
		reasons.push(`utility score ${input.metadata.utility_score.toFixed(2)}`);
	}
	if (input.metadata?.maturity !== undefined) {
		reasons.push(`maturity ${input.metadata.maturity}`);
	}
	if (input.metadata?.confirmed_by_source === true) {
		reasons.push("explicitly confirmed by source");
	} else if (input.metadata?.confirmed_by_source === false) {
		reasons.push("not yet confirmed by source");
	}
	if (input.metadata?.superseded_by) {
		reasons.push(`superseded by ${input.metadata.superseded_by}`);
	}
	if (input.daysSinceUsed !== null) {
		reasons.push(
			input.daysSinceUsed <= 30
				? "used recently"
				: `last used ${Math.round(input.daysSinceUsed)} days ago`,
		);
	}

	if (["decision", "gotcha", "invariant"].includes(input.node.kind)) {
		reasons.push(`${input.node.kind} memories rank strongly for planning`);
	}
	if (input.node.status === "deprecated") {
		reasons.push("deprecated status lowers trust");
	}
	if (input.trust === "low") {
		reasons.push("inspect before relying on this memory");
	}

	return reasons.slice(0, 8);
}

function daysSinceVerification(value: string, now: Date): number | null {
	const verifiedAt = Date.parse(value);
	if (!Number.isFinite(verifiedAt)) return null;
	return Math.max(0, (now.getTime() - verifiedAt) / MS_PER_DAY);
}

function daysSinceLastUsed(
	value: string | undefined,
	now: Date,
): number | null {
	if (value === undefined) return null;
	const usedAt = Date.parse(value);
	if (!Number.isFinite(usedAt)) return null;
	return Math.max(0, (now.getTime() - usedAt) / MS_PER_DAY);
}

function filterEdges(edges: Edge[], nodeIds: Set<string>): Edge[] {
	return edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
}

function clamp01(value: number): number {
	return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}
