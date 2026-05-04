import { promises as fs } from "node:fs";
import * as path from "node:path";
import { lock } from "proper-lockfile";
import { ensureSeedFile } from "./util/lock.js";

// =============================================================
// Telemetry — local-only metrics for M3 measurability.
//
// V1_SPEC §11 + TECH_SPEC §7: per-turn counters + weekly rollup, written
// to `<repoRoot>/.codemap/metrics.json`. Committed to git for team-wide
// ROI visibility (small file, useful diff history). Bounded to 1000 entries
// (newest first) so the file size stays tractable and diffs append at the
// top.
//
// No network. No PII. Counts only. Topic names are user-chosen slugs and
// already in graph.json — no new exposure.
//
// Opt-out: CODEMAP_TELEMETRY=false  OR  DO_NOT_TRACK=1  (industry convention).
// =============================================================

const METRICS_DIR = ".codemap";
const METRICS_FILE = "metrics.json";
const SCHEMA_VERSION = 1 as const;
const MAX_TURN_ENTRIES = 1000;

export interface PerTurnEntry {
  topic: string;
  ts: string;
  queries: number;
  results_returned: number;
  nodes_emitted: number;
  collisions_detected: number;
  cap_hit: boolean;
  stale_rechecks: number;
  links_made: number;
  validator_repairs: number;
}

export interface RollupEntry {
  /** YYYY-MM-DD of the Monday of the rolled-up week (ISO week). */
  week_of: string;
  total_nodes: number;
  verified_pct_7d: number;
  knowledge_kind_ratio: number;
  total_emissions: number;
  total_collisions: number;
  cap_hits: number;
}

export interface MetricsFile {
  version: 1;
  per_turn: PerTurnEntry[];
  rollup_weekly: RollupEntry[];
}

/**
 * Telemetry opt-out per 2026 industry conventions.
 * - `CODEMAP_TELEMETRY=false` (tool-specific)
 * - `DO_NOT_TRACK=1` or `DO_NOT_TRACK=true` (cross-tool standard)
 */
export function isTelemetryDisabled(): boolean {
  return (
    process.env.CODEMAP_TELEMETRY === "false" ||
    process.env.DO_NOT_TRACK === "1" ||
    process.env.DO_NOT_TRACK === "true"
  );
}

export class MetricsStore {
  private constructor(
    private readonly path: string,
    private data: MetricsFile,
  ) {}

  /**
   * Load the metrics store. Returns `null` if telemetry is disabled — callers
   * can use `if (m) m.recordX()` and short-circuit cleanly.
   *
   * Path resolution:
   *   options.customPath > CODEMAP_METRICS_PATH env > <repoRoot>/.codemap/metrics.json
   */
  static async load(
    repoRoot: string,
    options?: { customPath?: string },
  ): Promise<MetricsStore | null> {
    if (isTelemetryDisabled()) return null;

    const metricsPath =
      options?.customPath ??
      process.env.CODEMAP_METRICS_PATH ??
      path.join(repoRoot, METRICS_DIR, METRICS_FILE);

    let data: MetricsFile;
    try {
      const raw = await fs.readFile(metricsPath, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed?.version !== SCHEMA_VERSION ||
        !Array.isArray(parsed.per_turn) ||
        !Array.isArray(parsed.rollup_weekly)
      ) {
        throw new Error("metrics.json: schema invalid");
      }
      data = parsed as MetricsFile;
    } catch (err) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        data = {
          version: SCHEMA_VERSION,
          per_turn: [],
          rollup_weekly: [],
        };
      } else {
        throw err;
      }
    }

    return new MetricsStore(metricsPath, data);
  }

  /**
   * Push a new per-turn entry to the front of `per_turn[]`. Trims oldest
   * entries past MAX_TURN_ENTRIES so the file stays bounded.
   */
  startTurn(topic: string): void {
    const entry: PerTurnEntry = {
      topic,
      ts: new Date().toISOString(),
      queries: 0,
      results_returned: 0,
      nodes_emitted: 0,
      collisions_detected: 0,
      cap_hit: false,
      stale_rechecks: 0,
      links_made: 0,
      validator_repairs: 0,
    };
    this.data.per_turn.unshift(entry);
    if (this.data.per_turn.length > MAX_TURN_ENTRIES) {
      this.data.per_turn.length = MAX_TURN_ENTRIES;
    }
  }

  private currentEntry(): PerTurnEntry | null {
    return this.data.per_turn[0] ?? null;
  }

  recordQuery(resultsReturned: number): void {
    const e = this.currentEntry();
    if (!e) return;
    e.queries += 1;
    e.results_returned += resultsReturned;
  }

  recordEmit(): void {
    const e = this.currentEntry();
    if (!e) return;
    e.nodes_emitted += 1;
  }

  recordCollision(): void {
    const e = this.currentEntry();
    if (!e) return;
    e.collisions_detected += 1;
  }

  recordCap(): void {
    const e = this.currentEntry();
    if (!e) return;
    e.cap_hit = true;
  }

  recordLink(): void {
    const e = this.currentEntry();
    if (!e) return;
    e.links_made += 1;
  }

  recordStaleRecheck(count: number): void {
    const e = this.currentEntry();
    if (!e) return;
    e.stale_rechecks += count;
  }

  recordValidatorRepairs(count: number): void {
    const e = this.currentEntry();
    if (!e) return;
    e.validator_repairs += count;
  }

  /** Insert or update a weekly rollup entry, keyed by `week_of`. Newest first. */
  upsertRollup(entry: RollupEntry): void {
    const idx = this.data.rollup_weekly.findIndex(
      (r) => r.week_of === entry.week_of,
    );
    if (idx >= 0) {
      this.data.rollup_weekly[idx] = entry;
    } else {
      this.data.rollup_weekly.unshift(entry);
    }
  }

  /** Read-only data for tests + CLI. @internal */
  _data(): Readonly<MetricsFile> {
    return this.data;
  }

  async save(): Promise<void> {
    await ensureSeedFile(this.path, {
      version: SCHEMA_VERSION,
      per_turn: [],
      rollup_weekly: [],
    });

    const release = await lock(this.path, {
      retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
      stale: 10_000,
    });
    try {
      const tmp = `${this.path}.tmp`;
      await fs.writeFile(
        tmp,
        `${JSON.stringify(this.data, null, 2)}\n`,
        "utf8",
      );
      await fs.rename(tmp, this.path);
    } finally {
      await release();
    }
  }
}

/**
 * Helper for tools: load + op + save in a try/catch so telemetry failures
 * never break the actual tool call. Best-effort.
 */
export async function recordMetric(
  repoRoot: string,
  op: (m: MetricsStore) => void,
): Promise<void> {
  try {
    const metrics = await MetricsStore.load(repoRoot);
    if (metrics) {
      op(metrics);
      await metrics.save();
    }
  } catch {
    // Intentionally swallow — telemetry is never load-bearing.
  }
}

/**
 * ISO week date (Monday-anchored): YYYY-MM-DD of the Monday of `date`'s week.
 * Uses UTC throughout to avoid TZ rollover surprises.
 */
export function isoWeekOf(date: Date): string {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay() || 7; // Sunday → 7
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

/** Pure: compute the rollup aggregates from caller-supplied graph stats + recent turns. */
export function computeRollupStats(input: {
  totalNodes: number;
  knowledgeKind: number;
  verifiedRecently: number;
  recentTurns: PerTurnEntry[];
}): Omit<RollupEntry, "week_of"> {
  const { totalNodes, knowledgeKind, verifiedRecently, recentTurns } = input;
  const verifiedPct = totalNodes > 0 ? verifiedRecently / totalNodes : 0;
  const kkRatio = totalNodes > 0 ? knowledgeKind / totalNodes : 0;
  let totalEmissions = 0;
  let totalCollisions = 0;
  let capHits = 0;
  for (const e of recentTurns) {
    totalEmissions += e.nodes_emitted;
    totalCollisions += e.collisions_detected;
    if (e.cap_hit) capHits += 1;
  }
  return {
    total_nodes: totalNodes,
    verified_pct_7d: Number(verifiedPct.toFixed(3)),
    knowledge_kind_ratio: Number(kkRatio.toFixed(3)),
    total_emissions: totalEmissions,
    total_collisions: totalCollisions,
    cap_hits: capHits,
  };
}
