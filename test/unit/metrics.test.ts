import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MetricsStore,
  computeRollupStats,
  isTelemetryDisabled,
  isoWeekOf,
  recordMetric,
  type PerTurnEntry,
} from "../../src/metrics.js";

let tmpRoot: string;
let metricsPath: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-metrics-"));
  metricsPath = path.join(tmpRoot, ".codemap", "metrics.json");
  // Make sure no env-var bleed between tests
  delete process.env.CODEMAP_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.CODEMAP_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
});

// =============================================================
// isTelemetryDisabled
// =============================================================

describe("isTelemetryDisabled", () => {
  test("default (no env vars): enabled", () => {
    expect(isTelemetryDisabled()).toBe(false);
  });
  test("CODEMAP_TELEMETRY=false: disabled", () => {
    process.env.CODEMAP_TELEMETRY = "false";
    expect(isTelemetryDisabled()).toBe(true);
  });
  test("DO_NOT_TRACK=1: disabled", () => {
    process.env.DO_NOT_TRACK = "1";
    expect(isTelemetryDisabled()).toBe(true);
  });
  test("DO_NOT_TRACK=true: disabled", () => {
    process.env.DO_NOT_TRACK = "true";
    expect(isTelemetryDisabled()).toBe(true);
  });
  test("CODEMAP_TELEMETRY=true: enabled (only 'false' disables)", () => {
    process.env.CODEMAP_TELEMETRY = "true";
    expect(isTelemetryDisabled()).toBe(false);
  });
});

// =============================================================
// MetricsStore.load
// =============================================================

describe("MetricsStore.load", () => {
  test("returns null when telemetry is disabled (CODEMAP_TELEMETRY=false)", async () => {
    process.env.CODEMAP_TELEMETRY = "false";
    expect(await MetricsStore.load(tmpRoot)).toBeNull();
  });
  test("returns null when DO_NOT_TRACK=1", async () => {
    process.env.DO_NOT_TRACK = "1";
    expect(await MetricsStore.load(tmpRoot)).toBeNull();
  });
  test("returns a store with empty arrays when file is missing", async () => {
    const m = await MetricsStore.load(tmpRoot);
    expect(m).not.toBeNull();
    expect(m!._data().version).toBe(1);
    expect(m!._data().per_turn).toEqual([]);
    expect(m!._data().rollup_weekly).toEqual([]);
  });
  test("does not write the file on load (deferred to first save())", async () => {
    await MetricsStore.load(tmpRoot);
    await expect(fs.stat(metricsPath)).rejects.toThrow();
  });
  test("parses an existing valid file", async () => {
    await fs.mkdir(path.dirname(metricsPath), { recursive: true });
    await fs.writeFile(
      metricsPath,
      JSON.stringify({
        version: 1,
        per_turn: [
          {
            topic: "auth",
            ts: "2026-04-28T00:00:00.000Z",
            queries: 3,
            results_returned: 12,
            nodes_emitted: 1,
            collisions_detected: 0,
            cap_hit: false,
            stale_rechecks: 0,
            links_made: 2,
            validator_repairs: 0,
          },
        ],
        rollup_weekly: [],
      }),
    );
    const m = await MetricsStore.load(tmpRoot);
    expect(m?._data().per_turn).toHaveLength(1);
    expect(m?._data().per_turn[0]?.topic).toBe("auth");
  });
  test("throws on schema-invalid file", async () => {
    await fs.mkdir(path.dirname(metricsPath), { recursive: true });
    await fs.writeFile(
      metricsPath,
      JSON.stringify({ version: 99, garbage: true }),
    );
    await expect(MetricsStore.load(tmpRoot)).rejects.toThrow();
  });
  test("respects customPath option", async () => {
    const altPath = path.join(tmpRoot, "alt", "metrics.json");
    const m = await MetricsStore.load(tmpRoot, { customPath: altPath });
    await m!.save();
    expect((await fs.stat(altPath)).isFile()).toBe(true);
  });
});

// =============================================================
// startTurn + record* + bounded length
// =============================================================

describe("MetricsStore record*", () => {
  test("startTurn creates a new entry at the front", async () => {
    const m = (await MetricsStore.load(tmpRoot))!;
    m.startTurn("auth-bugfix");
    const head = m._data().per_turn[0]!;
    expect(head.topic).toBe("auth-bugfix");
    expect(head.queries).toBe(0);
    expect(head.cap_hit).toBe(false);
    expect(typeof head.ts).toBe("string");
  });
  test("record methods modify the front entry", async () => {
    const m = (await MetricsStore.load(tmpRoot))!;
    m.startTurn("auth");
    m.recordQuery(5);
    m.recordQuery(3);
    m.recordEmit();
    m.recordEmit();
    m.recordCollision();
    m.recordCap();
    m.recordLink();
    m.recordValidatorRepairs(2);
    const head = m._data().per_turn[0]!;
    expect(head.queries).toBe(2);
    expect(head.results_returned).toBe(8);
    expect(head.nodes_emitted).toBe(2);
    expect(head.collisions_detected).toBe(1);
    expect(head.cap_hit).toBe(true);
    expect(head.links_made).toBe(1);
    expect(head.validator_repairs).toBe(2);
  });
  test("record before any startTurn is a no-op", async () => {
    const m = (await MetricsStore.load(tmpRoot))!;
    m.recordQuery(5);
    m.recordEmit();
    expect(m._data().per_turn).toHaveLength(0);
  });
  test("starting many turns past 1000 trims oldest", async () => {
    const m = (await MetricsStore.load(tmpRoot))!;
    for (let i = 0; i < 1005; i++) m.startTurn(`t${i}`);
    expect(m._data().per_turn).toHaveLength(1000);
    expect(m._data().per_turn[0]?.topic).toBe("t1004"); // newest first
    expect(m._data().per_turn[999]?.topic).toBe("t5"); // oldest survivor
  });
});

// =============================================================
// upsertRollup
// =============================================================

describe("MetricsStore.upsertRollup", () => {
  test("first insert prepends to rollup_weekly", async () => {
    const m = (await MetricsStore.load(tmpRoot))!;
    m.upsertRollup({
      week_of: "2026-04-27",
      total_nodes: 10,
      verified_pct_7d: 0.5,
      knowledge_kind_ratio: 0.4,
      total_emissions: 3,
      total_collisions: 1,
      cap_hits: 0,
    });
    expect(m._data().rollup_weekly).toHaveLength(1);
  });
  test("second insert with same week_of replaces (no duplicate)", async () => {
    const m = (await MetricsStore.load(tmpRoot))!;
    m.upsertRollup({
      week_of: "2026-04-27",
      total_nodes: 10,
      verified_pct_7d: 0,
      knowledge_kind_ratio: 0,
      total_emissions: 0,
      total_collisions: 0,
      cap_hits: 0,
    });
    m.upsertRollup({
      week_of: "2026-04-27",
      total_nodes: 12,
      verified_pct_7d: 0.6,
      knowledge_kind_ratio: 0.5,
      total_emissions: 5,
      total_collisions: 2,
      cap_hits: 1,
    });
    expect(m._data().rollup_weekly).toHaveLength(1);
    expect(m._data().rollup_weekly[0]?.total_nodes).toBe(12);
  });
  test("different week_of values stay distinct", async () => {
    const m = (await MetricsStore.load(tmpRoot))!;
    m.upsertRollup({
      week_of: "2026-04-20",
      total_nodes: 1,
      verified_pct_7d: 0,
      knowledge_kind_ratio: 0,
      total_emissions: 0,
      total_collisions: 0,
      cap_hits: 0,
    });
    m.upsertRollup({
      week_of: "2026-04-27",
      total_nodes: 2,
      verified_pct_7d: 0,
      knowledge_kind_ratio: 0,
      total_emissions: 0,
      total_collisions: 0,
      cap_hits: 0,
    });
    expect(m._data().rollup_weekly).toHaveLength(2);
    expect(m._data().rollup_weekly[0]?.week_of).toBe("2026-04-27");
  });
});

// =============================================================
// save + round-trip
// =============================================================

describe("MetricsStore.save", () => {
  test("save creates the file on first write", async () => {
    const m = (await MetricsStore.load(tmpRoot))!;
    m.startTurn("auth");
    m.recordQuery(3); // one query that returned 3 results
    await m.save();
    const written = JSON.parse(await fs.readFile(metricsPath, "utf8"));
    expect(written.per_turn[0].topic).toBe("auth");
    expect(written.per_turn[0].queries).toBe(1);
    expect(written.per_turn[0].results_returned).toBe(3);
  });
  test("save → load round-trip preserves data", async () => {
    const m1 = (await MetricsStore.load(tmpRoot))!;
    m1.startTurn("payment");
    m1.recordEmit();
    m1.recordCollision();
    await m1.save();

    const m2 = (await MetricsStore.load(tmpRoot))!;
    expect(m2._data().per_turn[0]?.topic).toBe("payment");
    expect(m2._data().per_turn[0]?.nodes_emitted).toBe(1);
    expect(m2._data().per_turn[0]?.collisions_detected).toBe(1);
  });
});

// =============================================================
// recordMetric helper (best-effort wrapper)
// =============================================================

describe("recordMetric helper", () => {
  test("calls the op when telemetry is enabled and writes", async () => {
    await recordMetric(tmpRoot, (m) => {
      m.startTurn("auth");
      m.recordQuery(2); // one query returning 2 results
    });
    const m = (await MetricsStore.load(tmpRoot))!;
    expect(m._data().per_turn[0]?.queries).toBe(1);
    expect(m._data().per_turn[0]?.results_returned).toBe(2);
  });
  test("is a no-op when telemetry is disabled (no file created)", async () => {
    process.env.CODEMAP_TELEMETRY = "false";
    await recordMetric(tmpRoot, (m) => {
      m.startTurn("auth");
    });
    await expect(fs.stat(metricsPath)).rejects.toThrow();
  });
  test("swallows thrown errors from the op (best-effort guarantee)", async () => {
    // Should NOT throw to caller
    await recordMetric(tmpRoot, () => {
      throw new Error("internal failure");
    });
    // No exception bubbled up.
  });
});

// =============================================================
// isoWeekOf
// =============================================================

describe("isoWeekOf", () => {
  test("Monday returns same date", () => {
    // 2026-04-27 is a Monday.
    expect(isoWeekOf(new Date("2026-04-27T12:00:00Z"))).toBe("2026-04-27");
  });
  test("Sunday rolls back to the prior Monday", () => {
    // 2026-05-03 is a Sunday → Monday is 2026-04-27.
    expect(isoWeekOf(new Date("2026-05-03T23:59:59Z"))).toBe("2026-04-27");
  });
  test("Wednesday rolls back to that week's Monday", () => {
    expect(isoWeekOf(new Date("2026-04-29T08:00:00Z"))).toBe("2026-04-27");
  });
});

// =============================================================
// computeRollupStats
// =============================================================

describe("computeRollupStats", () => {
  function turn(o: Partial<PerTurnEntry>): PerTurnEntry {
    return {
      topic: "x",
      ts: "2026-04-28T00:00:00.000Z",
      queries: 0,
      results_returned: 0,
      nodes_emitted: 0,
      collisions_detected: 0,
      cap_hit: false,
      stale_rechecks: 0,
      links_made: 0,
      validator_repairs: 0,
      ...o,
    };
  }
  test("empty graph + empty turns: all zeros", () => {
    const r = computeRollupStats({
      totalNodes: 0,
      knowledgeKind: 0,
      verifiedRecently: 0,
      recentTurns: [],
    });
    expect(r).toEqual({
      total_nodes: 0,
      verified_pct_7d: 0,
      knowledge_kind_ratio: 0,
      total_emissions: 0,
      total_collisions: 0,
      cap_hits: 0,
    });
  });
  test("ratios computed correctly + rounded to 3 places", () => {
    const r = computeRollupStats({
      totalNodes: 12,
      knowledgeKind: 11,
      verifiedRecently: 7,
      recentTurns: [],
    });
    expect(r.knowledge_kind_ratio).toBe(0.917);
    expect(r.verified_pct_7d).toBe(0.583);
  });
  test("aggregates per-turn fields", () => {
    const r = computeRollupStats({
      totalNodes: 5,
      knowledgeKind: 5,
      verifiedRecently: 5,
      recentTurns: [
        turn({ nodes_emitted: 2, collisions_detected: 1, cap_hit: false }),
        turn({ nodes_emitted: 3, collisions_detected: 0, cap_hit: true }),
        turn({ nodes_emitted: 1, collisions_detected: 4, cap_hit: true }),
      ],
    });
    expect(r.total_emissions).toBe(6);
    expect(r.total_collisions).toBe(5);
    expect(r.cap_hits).toBe(2);
  });
});
