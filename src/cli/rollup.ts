import { GraphStore } from "../graph.js";
import {
  MetricsStore,
  computeRollupStats,
  isTelemetryDisabled,
  isoWeekOf,
  type RollupEntry,
} from "../metrics.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

const KNOWLEDGE_KINDS = new Set(["decision", "invariant", "gotcha"]);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `codemap rollup` — compute the metrics weekly rollup for the current ISO week.
 *
 * Pulls graph stats (total nodes, knowledge-kind ratio, recently-verified pct)
 * from `<repoRoot>/.codemap/graph.json`, joins with the per-turn entries from
 * the last 7 days in `metrics.json`, and upserts a `rollup_weekly[]` entry
 * keyed by the Monday of the current week.
 *
 * Per V1_SPEC §11. No-op (exit 0 with message) if telemetry is disabled.
 */
export async function rollup(options: GlobalOptions): Promise<CommandResult> {
  if (isTelemetryDisabled()) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        ok: true,
        message: "telemetry disabled — nothing to roll up",
      })}\n`,
    };
  }

  let graphStore: GraphStore;
  try {
    graphStore = await GraphStore.load(options.repoRoot);
  } catch (err) {
    return {
      exitCode: 2,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "SCHEMA_INVALID", message: String(err) },
      })}\n`,
    };
  }

  const metrics = await MetricsStore.load(options.repoRoot);
  if (!metrics) {
    // Disabled mid-run somehow (env-var change between checks); be safe.
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        ok: true,
        message: "telemetry disabled — nothing to roll up",
      })}\n`,
    };
  }

  // Graph-derived stats
  const graph = graphStore._data();
  const allNodes = Object.values(graph.nodes);
  const totalNodes = allNodes.length;
  let knowledgeKind = 0;
  let verifiedRecently = 0;
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  for (const node of allNodes) {
    if (KNOWLEDGE_KINDS.has(node.kind)) knowledgeKind += 1;
    if (new Date(node.last_verified_at).getTime() >= cutoff) {
      verifiedRecently += 1;
    }
  }

  // Per-turn entries from the last 7 days
  const recentTurns = metrics
    ._data()
    .per_turn.filter((e) => new Date(e.ts).getTime() >= cutoff);

  const stats = computeRollupStats({
    totalNodes,
    knowledgeKind,
    verifiedRecently,
    recentTurns,
  });

  const weekOf = isoWeekOf(new Date());
  const entry: RollupEntry = { week_of: weekOf, ...stats };
  metrics.upsertRollup(entry);
  await metrics.save();

  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ ok: true, rollup: entry }, null, 2)}\n`,
  };
}
