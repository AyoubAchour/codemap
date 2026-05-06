import type { QueryResult } from "./graph.js";
import type { StalenessReport } from "./staleness.js";
import type { Edge, Node, NodeKind } from "./types.js";

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
	factors: {
		confidence: number;
		source_freshness: number;
		verification_age: number;
		kind: number;
		status: number;
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
		return { checked_sources: 0, stale_sources: [] };
	}
	const nodeIds = new Set(nodes.map((node) => node.id));
	return {
		checked_sources: nodes.reduce((sum, node) => sum + node.sources.length, 0),
		stale_sources: staleness.stale_sources.filter((source) =>
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
		} else {
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
	};
	const score = round4(
		factors.confidence * 0.35 +
			factors.source_freshness * 0.25 +
			factors.verification_age * 0.2 +
			factors.kind * 0.1 +
			factors.status * 0.1,
	);
	const trust = trustTier({
		score,
		confidence: factors.confidence,
		freshness,
		status: node.status,
	});

	return {
		score,
		trust,
		freshness,
		confidence: node.confidence,
		age_days: ageDays === null ? null : Math.round(ageDays),
		checked_sources: checkedSources,
		stale_sources: staleSources,
		factors,
		reasons: qualityReasons({
			node,
			freshness,
			staleSources,
			checkedSources,
			ageDays,
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
	const staleRatio = checkedSources === 0 ? 1 : staleSources / checkedSources;
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
}): GraphMemoryTrust {
	if (
		input.status === "deprecated" ||
		input.freshness === "stale" ||
		input.confidence < 0.55 ||
		input.score < 0.62
	) {
		return "low";
	}
	if (
		input.freshness === "fresh" &&
		input.confidence >= 0.8 &&
		input.score >= 0.82
	) {
		return "high";
	}
	return "medium";
}

function qualityReasons(input: {
	node: Node;
	freshness: GraphMemoryFreshness;
	staleSources: number;
	checkedSources: number;
	ageDays: number | null;
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

	if (["decision", "gotcha", "invariant"].includes(input.node.kind)) {
		reasons.push(`${input.node.kind} memories rank strongly for planning`);
	}
	if (input.node.status === "deprecated") {
		reasons.push("deprecated status lowers trust");
	}
	if (input.trust === "low") {
		reasons.push("inspect before relying on this memory");
	}

	return reasons.slice(0, 6);
}

function daysSinceVerification(value: string, now: Date): number | null {
	const verifiedAt = Date.parse(value);
	if (!Number.isFinite(verifiedAt)) return null;
	return Math.max(0, (now.getTime() - verifiedAt) / MS_PER_DAY);
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
