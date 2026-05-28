import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { benchmarkRetrieval } from "../../src/cli/benchmark_retrieval.js";
import {
  type CaptureEventFlags,
  captureEvent,
} from "../../src/cli/capture_event.js";
import { captureReport } from "../../src/cli/capture_report.js";
import {
  type CaptureSessionFlags,
  captureSession,
} from "../../src/cli/capture_session.js";
import { changesContext } from "../../src/cli/changes_context.js";
import { clearIndex } from "../../src/cli/clear_index.js";
import { context } from "../../src/cli/context.js";
import { correct } from "../../src/cli/correct.js";
import { deprecate } from "../../src/cli/deprecate.js";
import { doctor } from "../../src/cli/doctor.js";
import { generateSkills } from "../../src/cli/generate_skills.js";
import { indexStatus } from "../../src/cli/index_status.js";
import { init } from "../../src/cli/init.js";
import { recallContext } from "../../src/cli/recall_context.js";
import { repairGraph } from "../../src/cli/repair_graph.js";
import { rollup } from "../../src/cli/rollup.js";
import { scan } from "../../src/cli/scan.js";
import { searchSource } from "../../src/cli/search_source.js";
import { setup } from "../../src/cli/setup.js";
import { show } from "../../src/cli/show.js";
import { suggestWriteback } from "../../src/cli/suggest_writeback.js";
import { validate } from "../../src/cli/validate.js";
import { watchLive } from "../../src/cli/watch.js";
import { GraphStore } from "../../src/graph.js";
import {
  GUIDANCE_POLICY_HASH,
  SERVER_INSTRUCTIONS,
} from "../../src/instructions.js";
import { setupCodemap } from "../../src/setup.js";
import { hashBuffer, hashSourceRange } from "../../src/staleness.js";
import type { Node } from "../../src/types.js";

let tmpRoot: string;
const projectRoot = path.resolve(import.meta.dir, "../..");
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-cli-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeNode(overrides: Partial<Node> & { id: string }): Node {
  return {
    kind: "invariant",
    name: overrides.id,
    summary: "test summary",
    sources: [
      {
        file_path: "src/x.ts",
        line_range: [1, 10],
        content_hash: "sha256:placeholder",
      },
    ],
    tags: [],
    aliases: [],
    status: "active",
    confidence: 0.9,
    last_verified_at: "2026-04-28T00:00:00Z",
    ...overrides,
  };
}

async function seed(
  nodes: Node[],
  edges: Array<[string, string, string, string?]> = [],
): Promise<void> {
  const store = await GraphStore.load(tmpRoot);
  for (const node of nodes) {
    store.upsertNode(node);
  }
  for (const [from, to, kind, note] of edges) {
    store.ensureEdge(from, to, kind as never, note);
  }
  await store.save();
}

async function runCodemapBin(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    [
      "run",
      path.join(projectRoot, "bin/codemap.ts"),
      "--repo",
      tmpRoot,
      ...args,
    ],
    {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  return { exitCode, stdout, stderr };
}

async function readProjectSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(projectRoot, relativePath), "utf8");
}

async function runGit(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: tmpRoot });
}

// =============================================================
// show
// =============================================================

describe("CLI: show", () => {
  test("happy path: returns node + incident edges", async () => {
    await seed(
      [
        makeNode({ id: "a/x", tags: ["a"] }),
        makeNode({ id: "a/y", tags: ["a"] }),
      ],
      [["a/x", "a/y", "depends_on", "uses y"]],
    );
    const r = await show("a/x", { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBeUndefined();
    const out = JSON.parse(r.stdout!);
    expect(out.ok).toBe(true);
    expect(out.node.id).toBe("a/x");
    expect(out.edges).toEqual([
      { from: "a/x", to: "a/y", kind: "depends_on", note: "uses y" },
    ]);
  });

  test("alias resolution: passing an alias returns the canonical node", async () => {
    await seed([makeNode({ id: "a/canonical", aliases: ["the-alias"] })]);
    const r = await show("the-alias", { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout!);
    expect(out.node.id).toBe("a/canonical");
  });

  test("not found: exits 1 with stderr error", async () => {
    await seed([]);
    const r = await show("nope", { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBeUndefined();
    const err = JSON.parse(r.stderr!);
    expect(err.error.code).toBe("NODE_NOT_FOUND");
  });

  test("schema-invalid graph: exits 2 with SCHEMA_INVALID", async () => {
    await fs.mkdir(path.join(tmpRoot, ".codemap"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, ".codemap", "graph.json"),
      JSON.stringify({ version: 99 }),
    );
    const r = await show("anything", { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stderr!).error.code).toBe("SCHEMA_INVALID");
  });
});

// =============================================================
// correct
// =============================================================

describe("CLI: correct", () => {
  test("scalar: --summary replaces summary regardless of confidence (overrideNode bypass)", async () => {
    // Seed a high-confidence node — upsertNode would refuse a summary
    // change with lower confidence, but the CLI explicitly overrides.
    await seed([
      makeNode({ id: "a/x", summary: "original", confidence: 0.95 }),
    ]);
    const r = await correct(
      "a/x",
      { summary: "rewritten by the user" },
      { repoRoot: tmpRoot },
    );
    expect(r.exitCode).toBe(0);
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("a/x")?.summary).toBe("rewritten by the user");
  });

  test("scalar: --confidence rejects out-of-range value (1)", async () => {
    await seed([makeNode({ id: "a/x" })]);
    const r = await correct("a/x", { confidence: 1.5 }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr!).error.code).toBe("INVALID_FLAG");
  });

  test("scalar: --confidence rejects out-of-range value (-)", async () => {
    await seed([makeNode({ id: "a/x" })]);
    const r = await correct("a/x", { confidence: -0.1 }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
  });

  test("scalar: --status rejects an unknown value", async () => {
    await seed([makeNode({ id: "a/x" })]);
    const r = await correct(
      "a/x",
      { status: "removed" },
      { repoRoot: tmpRoot },
    );
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr!).error.code).toBe("INVALID_FLAG");
  });

  test("lists: --add-tag and --remove-tag merge correctly", async () => {
    await seed([makeNode({ id: "a/x", tags: ["one", "two"] })]);
    const r = await correct(
      "a/x",
      { addTag: ["three"], removeTag: ["one"] },
      { repoRoot: tmpRoot },
    );
    expect(r.exitCode).toBe(0);
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("a/x")?.tags.sort()).toEqual(["three", "two"]);
  });

  test("lists: --add-tag dedupes", async () => {
    await seed([makeNode({ id: "a/x", tags: ["one"] })]);
    const r = await correct(
      "a/x",
      { addTag: ["one", "two"] },
      { repoRoot: tmpRoot },
    );
    expect(r.exitCode).toBe(0);
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("a/x")?.tags.sort()).toEqual(["one", "two"]);
  });

  test("lists: --add-alias / --remove-alias work the same way", async () => {
    await seed([makeNode({ id: "a/x", aliases: ["ax"] })]);
    const r = await correct(
      "a/x",
      { addAlias: ["a-x", "x"], removeAlias: ["ax"] },
      { repoRoot: tmpRoot },
    );
    expect(r.exitCode).toBe(0);
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("a/x")?.aliases.sort()).toEqual(["a-x", "x"]);
  });

  test("no flags supplied: no-op, exits 0 with informative stdout", async () => {
    await seed([makeNode({ id: "a/x", summary: "untouched" })]);
    const r = await correct("a/x", {}, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout!).message).toContain("nothing changed");
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("a/x")?.summary).toBe("untouched");
  });

  test("not found: exits 1", async () => {
    await seed([]);
    const r = await correct("missing", { summary: "x" }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr!).error.code).toBe("NODE_NOT_FOUND");
  });

  test("alias resolution: correct via alias mutates the canonical node", async () => {
    await seed([
      makeNode({
        id: "a/canonical",
        aliases: ["alias-1"],
        summary: "old",
      }),
    ]);
    const r = await correct(
      "alias-1",
      { summary: "new" },
      { repoRoot: tmpRoot },
    );
    expect(r.exitCode).toBe(0);
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("a/canonical")?.summary).toBe("new");
  });

  test("schema-invalid graph: exits 2 with SCHEMA_INVALID", async () => {
    await fs.mkdir(path.join(tmpRoot, ".codemap"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, ".codemap", "graph.json"),
      JSON.stringify({ version: 99 }),
    );
    const r = await correct("any", { summary: "x" }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stderr!).error.code).toBe("SCHEMA_INVALID");
  });

  test("last_verified_at gets bumped on any successful change", async () => {
    await seed([
      makeNode({
        id: "a/x",
        last_verified_at: "2020-01-01T00:00:00Z",
      }),
    ]);
    const before = Date.now();
    await correct("a/x", { name: "renamed" }, { repoRoot: tmpRoot });
    const verify = await GraphStore.load(tmpRoot);
    const after = new Date(verify.getNode("a/x")!.last_verified_at).getTime();
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

// =============================================================
// deprecate
// =============================================================

describe("CLI: deprecate", () => {
  test("sets status to deprecated", async () => {
    await seed([makeNode({ id: "a/x", status: "active" })]);
    const r = await deprecate("a/x", {}, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("a/x")?.status).toBe("deprecated");
  });

  test("--reason prepends '[deprecated: <r>] ' to summary", async () => {
    await seed([makeNode({ id: "a/x", summary: "Original behavior." })]);
    const r = await deprecate(
      "a/x",
      { reason: "replaced by a/y" },
      { repoRoot: tmpRoot },
    );
    expect(r.exitCode).toBe(0);
    const verify = await GraphStore.load(tmpRoot);
    expect(verify.getNode("a/x")?.summary).toBe(
      "[deprecated: replaced by a/y] Original behavior.",
    );
  });

  test("not found: exits 1", async () => {
    await seed([]);
    const r = await deprecate("nope", {}, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr!).error.code).toBe("NODE_NOT_FOUND");
  });

  test("schema-invalid graph: exits 2 with SCHEMA_INVALID", async () => {
    await fs.mkdir(path.join(tmpRoot, ".codemap"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, ".codemap", "graph.json"),
      JSON.stringify({ version: 99 }),
    );
    const r = await deprecate("any", {}, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stderr!).error.code).toBe("SCHEMA_INVALID");
  });
});

// =============================================================
// validate
// =============================================================

describe("CLI: validate", () => {
  test("clean graph → exits 0", async () => {
    await seed([makeNode({ id: "a/x", tags: [] })]);
    const r = await validate({ repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout!).ok).toBe(true);
  });

  test("dirty graph (auto-repaired missing topic) → exits 1 with structured report", async () => {
    // Write a graph file directly with a tag whose topic is missing —
    // GraphStore.load() applies the missing-topic repair in-memory; CLI
    // validate reports it.
    await fs.mkdir(path.join(tmpRoot, ".codemap"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, ".codemap", "graph.json"),
      JSON.stringify({
        version: 1,
        created_at: "2026-04-28T00:00:00Z",
        topics: {},
        nodes: {
          "a/x": {
            kind: "invariant",
            name: "x",
            summary: "x",
            sources: [
              {
                file_path: "x.ts",
                line_range: [1, 10],
                content_hash: "sha256:placeholder",
              },
            ],
            tags: ["needs-this-topic"],
            aliases: [],
            status: "active",
            confidence: 0.9,
            last_verified_at: "2026-04-28T00:00:00Z",
          },
        },
        edges: {},
      }),
    );
    const r = await validate({ repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout!);
    expect(out.ok).toBe(false);
    expect(out.repairs.length).toBeGreaterThan(0);
  });

  test("schema-invalid graph → exits 2", async () => {
    await fs.mkdir(path.join(tmpRoot, ".codemap"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, ".codemap", "graph.json"),
      JSON.stringify({ version: 99 }), // missing required top-level fields
    );
    const r = await validate({ repoRoot: tmpRoot });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stderr!).error.code).toBe("SCHEMA_INVALID");
  });
});

// =============================================================
// doctor
// =============================================================

describe("CLI: doctor", () => {
  test("empty graph exits 0 with a compact clean health report", async () => {
    const r = await doctor({}, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Codemap graph health: clean");
    expect(r.stdout).toContain("Sources: 0 checked, 0 stale");
  });

  test("stale graph exits 1 with compact grouped issues", async () => {
    await seed([makeNode({ id: "a/stale" })]);
    const r = await doctor({}, { repoRoot: tmpRoot });

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Codemap graph health: issues found");
    expect(r.stdout).toContain("Sources: 1 checked, 1 stale");
    expect(r.stdout).toContain("Stale source anchors:");
    expect(r.stdout).toContain("a/stale -> src/x.ts");
  });

  test("range-fresh anchors are reported outside the stale breakdown", async () => {
    const original = Buffer.from("const preamble = 1;\nexport const x = 1;\n");
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "src/x.ts"), original);
    await seed([
      makeNode({
        id: "a/range-fresh",
        sources: [
          {
            file_path: "src/x.ts",
            line_range: [2, 2],
            content_hash: hashBuffer(original),
            range_hash: hashSourceRange(original, [2, 2]),
          },
        ],
      }),
    ]);
    await fs.writeFile(
      path.join(tmpRoot, "src/x.ts"),
      "const preamble = 2;\nexport const x = 1;\n",
    );

    const r = await doctor({}, { repoRoot: tmpRoot });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "Sources: 1 checked, 0 stale (0 anchor changed, 0 legacy changed, 0 missing, 0 unsafe, 0 read errors), 1 range-fresh",
    );
  });

  test("--json preserves the full structured health report", async () => {
    await seed([makeNode({ id: "a/stale" })]);
    const r = await doctor({ json: true }, { repoRoot: tmpRoot });

    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout!);
    expect(out.summary.fresh).toBe(false);
    expect(out.summary.missing_sources).toBe(1);
    expect(out.staleness.stale_sources).toHaveLength(1);
  });

  test("bin doctor --json preserves structured output", async () => {
    await seed([makeNode({ id: "a/stale" })]);
    const r = await runCodemapBin(["doctor", "--json"]);

    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).summary.missing_sources).toBe(1);
  });

  test("bin doctor --json flushes large unhealthy reports before exiting", async () => {
    await seed(
      Array.from({ length: 180 }, (_, i) =>
        makeNode({ id: `large/stale-${i}` }),
      ),
    );
    const r = await runCodemapBin(["doctor", "--json"]);

    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.summary.missing_sources).toBe(180);
    expect(out.staleness.stale_sources).toHaveLength(180);
  });
});

// =============================================================
// repair-graph
// =============================================================

describe("CLI: repair-graph", () => {
  test("reports read-only graph anchor repair proposals", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "src/x.ts"), "export const x = 1;\n");
    await seed([makeNode({ id: "a/legacy" })]);

    const r = await repairGraph({ json: true }, { repoRoot: tmpRoot });

    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout!);
    expect(out.summary.legacy_anchors).toBe(1);
    expect(out.proposals[0]).toEqual(
      expect.objectContaining({
        node_id: "a/legacy",
        action: "reanchor_legacy_source",
        legacy: true,
        replacement_source: expect.objectContaining({
          file_path: "src/x.ts",
          range_hash: expect.stringMatching(/^sha256:/),
        }),
      }),
    );
  });

  test("bin repair-graph --json preserves structured output", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "src/x.ts"), "export const x = 1;\n");
    await seed([makeNode({ id: "a/legacy" })]);

    const r = await runCodemapBin(["repair-graph", "--json"]);

    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).summary.legacy_anchors).toBe(1);
  });
});

// =============================================================
// rollup (real implementation lands in task-016 — comprehensive tests
// for behavior live in test/unit/metrics.test.ts; here we just verify
// the CLI wiring exits 0 and respects telemetry opt-out).
// =============================================================

describe("CLI: rollup", () => {
  test("on a fresh / empty graph: exits 0 with a rollup payload", async () => {
    const r = await rollup({ repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout!);
    expect(out.ok).toBe(true);
    expect(out.rollup.week_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.rollup.total_nodes).toBe(0);
  });

  test("when telemetry is disabled: exits 0 with a no-op message", async () => {
    const orig = process.env.CODEMAP_TELEMETRY;
    process.env.CODEMAP_TELEMETRY = "false";
    try {
      const r = await rollup({ repoRoot: tmpRoot });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout!).message).toContain("disabled");
    } finally {
      if (orig === undefined) delete process.env.CODEMAP_TELEMETRY;
      else process.env.CODEMAP_TELEMETRY = orig;
    }
  });
});

// =============================================================
// GraphStore.overrideNode (the new public method)
// =============================================================

describe("GraphStore.overrideNode", () => {
  test("replaces fields and bumps last_verified_at to now", async () => {
    await seed([
      makeNode({
        id: "a/x",
        summary: "old",
        confidence: 0.9,
        last_verified_at: "2020-01-01T00:00:00Z",
      }),
    ]);
    const store = await GraphStore.load(tmpRoot);
    const ok = store.overrideNode("a/x", { summary: "new" });
    expect(ok).toBe(true);
    expect(store.getNode("a/x")?.summary).toBe("new");
    expect(
      new Date(store.getNode("a/x")!.last_verified_at).getTime(),
    ).toBeGreaterThan(new Date("2020-01-01T00:00:00Z").getTime());
  });

  test("returns false for missing id", async () => {
    const store = await GraphStore.load(tmpRoot);
    expect(store.overrideNode("nope", { summary: "x" })).toBe(false);
  });
});

// =============================================================
// CLI: init  (task-021 / v0.2.0)
// Generates AGENTS.md (and optionally CLAUDE.md) from the same
// SERVER_INSTRUCTIONS the MCP server attaches via `instructions`.
// =============================================================

describe("CLI: init", () => {
  test("writes AGENTS.md by default and exits 0", async () => {
    const r = await init({}, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("wrote AGENTS.md");

    const written = await fs.readFile(path.join(tmpRoot, "AGENTS.md"), "utf8");
    // Body must contain the protocol-level lifecycle string verbatim
    // (single-source-of-truth contract — if this regresses, the in-protocol
    // and in-file copies have drifted, which defeats the whole point of
    // agentsMdContent reusing SERVER_INSTRUCTIONS).
    expect(written).toContain(SERVER_INSTRUCTIONS);
    expect(written).toContain("agent guidance (codemap)");
    expect(written).toContain("<!-- codemap:init version=");
    expect(written).toContain(`policy_hash=${GUIDANCE_POLICY_HASH}`);
    expect(written).toContain("Agent Contract");
    expect(written).toContain("Use Codemap for repository work only.");
    expect(written).toContain("source-index results as discovery hints only");
    expect(written).toContain("call `graph_health`");
    expect(written).toContain("Why this file exists");
    expect(written).toContain("codemap init --check");
    expect(written).toContain("codemap init --force");
  });

  test("uses repo basename in heading", async () => {
    const projDir = path.join(tmpRoot, "voice2work-fixture");
    await fs.mkdir(projDir);
    const r = await init({}, { repoRoot: projDir });
    expect(r.exitCode).toBe(0);
    const written = await fs.readFile(path.join(projDir, "AGENTS.md"), "utf8");
    expect(written).toContain("# voice2work-fixture — agent guidance");
  });

  test("skips with warning + exit 1 when AGENTS.md already exists", async () => {
    await fs.writeFile(
      path.join(tmpRoot, "AGENTS.md"),
      "previous content",
      "utf8",
    );
    const r = await init({}, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("skipped AGENTS.md");
    expect(r.stderr).toContain("--force");
    // Original content preserved
    const after = await fs.readFile(path.join(tmpRoot, "AGENTS.md"), "utf8");
    expect(after).toBe("previous content");
  });

  test("--force overwrites an existing AGENTS.md and exits 0", async () => {
    await fs.writeFile(
      path.join(tmpRoot, "AGENTS.md"),
      "previous content",
      "utf8",
    );
    const r = await init({ force: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("wrote AGENTS.md");
    const after = await fs.readFile(path.join(tmpRoot, "AGENTS.md"), "utf8");
    expect(after).toContain(SERVER_INSTRUCTIONS);
  });

  test("--claude writes both AGENTS.md and CLAUDE.md", async () => {
    const r = await init({ claude: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("wrote AGENTS.md");
    expect(r.stdout).toContain("wrote CLAUDE.md");
    const agents = await fs.readFile(path.join(tmpRoot, "AGENTS.md"), "utf8");
    const claude = await fs.readFile(path.join(tmpRoot, "CLAUDE.md"), "utf8");
    expect(agents).toContain(SERVER_INSTRUCTIONS);
    expect(claude).toContain(SERVER_INSTRUCTIONS);
    // Bodies should be identical when project basename is the same
    expect(agents).toBe(claude);
  });

  test("--all writes every known preamble file", async () => {
    const r = await init({ all: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("wrote AGENTS.md");
    expect(r.stdout).toContain("wrote CLAUDE.md");
  });

  test("partial-skip path: AGENTS.md exists + --claude → exit 0 (CLAUDE.md still written)", async () => {
    // Validates the exit-code contract: skip alone → 1, but if at least
    // one file was written, we exit 0 (the operation made progress).
    await fs.writeFile(path.join(tmpRoot, "AGENTS.md"), "preexisting", "utf8");
    const r = await init({ claude: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("skipped AGENTS.md");
    expect(r.stdout).toContain("wrote CLAUDE.md");
  });

  test("--check reports missing guidance without writing", async () => {
    const r = await init({ check: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("AGENTS.md: missing");
    await expect(fs.access(path.join(tmpRoot, "AGENTS.md"))).rejects.toThrow();
  });

  test("--check reports current guidance", async () => {
    await init({}, { repoRoot: tmpRoot });
    const r = await init({ check: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("AGENTS.md: current");
    expect(r.stdout).toContain(GUIDANCE_POLICY_HASH);
  });

  test("--check --force is rejected because check mode is read-only", async () => {
    await fs.writeFile(
      path.join(tmpRoot, "AGENTS.md"),
      "previous content",
      "utf8",
    );
    const r = await init({ check: true, force: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--check is read-only");
    const after = await fs.readFile(path.join(tmpRoot, "AGENTS.md"), "utf8");
    expect(after).toBe("previous content");
  });

  test("--check reports stale guidance without metadata", async () => {
    await fs.writeFile(
      path.join(tmpRoot, "AGENTS.md"),
      "previous content",
      "utf8",
    );
    const r = await init({ check: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("AGENTS.md: stale");
    expect(r.stdout).toContain("missing_metadata");
  });

  test("--check reports stale guidance with an old version marker", async () => {
    await init({}, { repoRoot: tmpRoot });
    const target = path.join(tmpRoot, "AGENTS.md");
    const current = await fs.readFile(target, "utf8");
    await fs.writeFile(
      target,
      current.replace(/version=\S+/, "version=0.0.0"),
      "utf8",
    );
    const r = await init({ check: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("version_mismatch");
    expect(r.stdout).toContain("version 0.0.0");
  });

  test("--check reports stale guidance with a mismatched policy hash", async () => {
    await init({}, { repoRoot: tmpRoot });
    const target = path.join(tmpRoot, "AGENTS.md");
    const current = await fs.readFile(target, "utf8");
    const staleHash = `sha256:${"0".repeat(64)}`;
    expect(staleHash).not.toBe(GUIDANCE_POLICY_HASH);
    await fs.writeFile(
      target,
      current.replace(GUIDANCE_POLICY_HASH, staleHash),
      "utf8",
    );
    const r = await init({ check: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("policy_hash_mismatch");
    expect(r.stdout).toContain(staleHash);
  });

  test("--check --claude reports partial current/missing state", async () => {
    await init({}, { repoRoot: tmpRoot });
    const r = await init({ check: true, claude: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("AGENTS.md: current");
    expect(r.stdout).toContain("CLAUDE.md: missing");
  });

  test("bin init --check reports current guidance", async () => {
    await init({}, { repoRoot: tmpRoot });
    const result = await runCodemapBin(["init", "--check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("AGENTS.md: current");
  });
});

// =============================================================
// source index CLI
// =============================================================

describe("CLI: source index", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      [
        "export interface SessionUser { id: string }",
        "export function requireActiveUser(token: string): SessionUser {",
        "  return { id: token };",
        "}",
      ].join("\n"),
    );
  });

  test("scan, search-source, index-status, and clear-index work together", async () => {
    const scanResult = await scan({}, { repoRoot: tmpRoot });
    expect(scanResult.exitCode).toBe(0);
    expect(JSON.parse(scanResult.stdout!).stats.files_indexed).toBe(1);

    const searchResult = await searchSource(
      "active user",
      { limit: 1, dependencyLimit: 1, includeImpact: true },
      { repoRoot: tmpRoot },
    );
    expect(searchResult.exitCode).toBe(0);
    const searched = JSON.parse(searchResult.stdout!);
    expect(searched.results[0].file_path).toBe("src/auth.ts");
    expect(searched.results[0].impact_context.target.file_path).toBe(
      "src/auth.ts",
    );

    const statusResult = await indexStatus({ repoRoot: tmpRoot });
    expect(statusResult.exitCode).toBe(0);
    expect(JSON.parse(statusResult.stdout!).fresh).toBe(true);

    const clearResult = await clearIndex({ repoRoot: tmpRoot });
    expect(clearResult.exitCode).toBe(0);

    const missingSearch = await searchSource(
      "active user",
      {},
      { repoRoot: tmpRoot },
    );
    expect(missingSearch.exitCode).toBe(1);
    expect(JSON.parse(missingSearch.stderr!).error.code).toBe("INDEX_MISSING");
  });

  test("watch --once refreshes a stale source index", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "watch.ts"),
      "export const WATCH_VALUE = 'old';\n",
    );
    await scan({}, { repoRoot: tmpRoot });
    await fs.writeFile(
      path.join(tmpRoot, "src", "watch.ts"),
      "export const WATCH_VALUE = 'new';\n",
    );

    const result = await runCodemapBin([
      "--repo",
      tmpRoot,
      "watch",
      "--once",
      "--interval-ms",
      "250",
    ]);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.refreshed).toBe(true);
    expect(out.reason).toBe("stale");
    expect(out.source_after.fresh).toBe(true);
    await expect(
      fs.stat(path.join(tmpRoot, ".codemap", "graph.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("watch --once exits nonzero when refresh fails but old index is readable", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "watch.ts"),
      "export const WATCH_VALUE = 'old';\n",
    );
    await scan({}, { repoRoot: tmpRoot });
    await fs.writeFile(
      path.join(tmpRoot, "src", "new-watch.ts"),
      "export const NEW_WATCH_VALUE = true;\n",
    );
    const blockedTmpPath = path.join(
      tmpRoot,
      ".codemap",
      "index",
      "source.json.tmp",
    );
    await fs.mkdir(blockedTmpPath, { recursive: true });

    try {
      const result = await runCodemapBin([
        "--repo",
        tmpRoot,
        "watch",
        "--once",
      ]);

      expect(result.exitCode).toBe(1);
      const out = JSON.parse(result.stdout);
      expect(out.ok).toBe(true);
      expect(out.watcher.last_result).toBe("error");
      expect(out.watcher.last_error).toContain("source.json.tmp");
      expect(out.source_after.indexed).toBe(true);
      expect(out.source_after.error).toBeUndefined();
    } finally {
      await fs.rm(blockedTmpPath, { recursive: true, force: true });
    }
  });

  test("watch --status reports freshness without refreshing", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "watch.ts"),
      "export const WATCH_VALUE = 'old';\n",
    );
    await scan({}, { repoRoot: tmpRoot });
    await fs.writeFile(
      path.join(tmpRoot, "src", "new.ts"),
      "export const NEW_VALUE = true;\n",
    );

    const result = await runCodemapBin([
      "--repo",
      tmpRoot,
      "watch",
      "--status",
    ]);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.source.new_files).toBe(1);
    expect(out.source.fresh).toBe(false);
    expect(out.watcher.active).toBe(false);
  });

  test("watch live exits after abort without a trailing one-shot refresh", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "watch.ts"),
      "export const WATCH_VALUE = true;\n",
    );
    await scan({}, { repoRoot: tmpRoot });

    const controller = new AbortController();
    let stdout = "";
    let watchResult!: ReturnType<typeof watchLive>;
    const firstLine = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("timed out waiting for watch output"));
      }, 5000);
      void timeout.unref?.();
      watchResult = watchLive(
        { intervalMs: 1000 },
        {
          repoRoot: tmpRoot,
          signal: controller.signal,
          write: (text) => {
            stdout += text;
            if (stdout.includes("\n")) {
              clearTimeout(timeout);
              controller.abort();
              resolve();
            }
          },
        },
      );
      watchResult.then(
        (commandResult) => {
          if (!stdout.includes("\n")) {
            clearTimeout(timeout);
            reject(new Error(`watch exited early with ${commandResult.exitCode}`));
          }
        },
        reject,
      );
    });

    await firstLine;
    const result = await watchResult;
    expect(result.exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(
      expect.objectContaining({ event: "watch_tick", ok: true }),
    );
  });

  test("context builds a missing source index by default", async () => {
    const result = await context(
      "active user",
      { sourceLimit: 1 },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.ok).toBe(true);
    expect(out.mode).toBe("standard");
    expect(out.summary.source_hits[0].file_path).toBe("src/auth.ts");
    expect(out.summary.repo_map.files[0]).toEqual(
      expect.objectContaining({
        file_path: "src/auth.ts",
        role: "source",
      }),
    );
    expect(out.expansion.source_files[0].file_path).toBe("src/auth.ts");
    expect(out.source.refreshed).toBe(true);
    expect(out.source.status.indexed).toBe(true);
    expect(out.source.search.results[0].file_path).toBe("src/auth.ts");
  });

  test("recall-context returns a compact budgeted packet from shared core", async () => {
    const result = await recallContext(
      "active user",
      { budgetBytes: 1800, limit: 2, refreshIndex: "if_missing" },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.ok).toBe(true);
    expect(out.budget.budget_bytes).toBe(1800);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(
      1800,
    );
    expect(out.results[0]).toEqual(
      expect.objectContaining({
        kind: "source",
        provenance: "rebuildable_source_index",
        file_path: "src/auth.ts",
      }),
    );
  });

  test("bin recall-context wires budget and filters", async () => {
    const result = await runCodemapBin([
      "recall-context",
      "active user",
      "--budget",
      "1800",
      "--limit",
      "2",
      "--file",
      "src/auth.ts",
      "--symbol",
      "requireActiveUser",
    ]);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.filters).toEqual({
      files: ["src/auth.ts"],
      symbols: ["requireActiveUser"],
    });
    expect(out.results[0].file_path).toBe("src/auth.ts");
    expect(out.budget.used_bytes).toBeLessThanOrEqual(1800);
  });

  test("bin context wires an explicit response budget", async () => {
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      [
        "export interface SessionUser { id: string }",
        "export function requireActiveUser(token: string): SessionUser {",
        "  const auditTrail = [",
        ...Array.from(
          { length: 80 },
          (_value, index) =>
            `    "auth audit marker ${index} requireActiveUser active user budget",`,
        ),
        "  ];",
        "  return { id: auditTrail.includes(token) ? token : token };",
        "}",
      ].join("\n"),
    );

    const result = await runCodemapBin([
      "context",
      "requireActiveUser active user",
      "--source-limit",
      "1",
      "--max-content-chars",
      "3000",
      "--budget",
      "6500",
    ]);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.budget.budget_bytes).toBe(6500);
    expect(out.budget.used_bytes).toBeLessThanOrEqual(6500);
    expect(out.budget.within_budget).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(6500);
    expect(out.source.search.results[0].file_path).toBe("src/auth.ts");
    expect(out.warnings).toContain(
      "Query context was trimmed to stay within the configured byte budget.",
    );
  });

  test("context warns when repo map rankings come from a stale source index", async () => {
    const scanResult = await scan({}, { repoRoot: tmpRoot });
    expect(scanResult.exitCode).toBe(0);
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      [
        "export interface SessionUser { id: string }",
        "export function requireActiveUser(token: string): SessionUser {",
        "  if (!token) throw new Error('missing token');",
        "  return { id: token };",
        "}",
      ].join("\n"),
    );

    const result = await context(
      "active user",
      { sourceLimit: 1, refreshIndex: "never" },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.source.status.fresh).toBe(false);
    expect(out.repo_map.files[0].file_path).toBe("src/auth.ts");
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Source index is stale"),
        expect.stringContaining("Repo map rankings are rebuildable"),
      ]),
    );
  });

  test("context reports source-index load failures as warnings", async () => {
    const scanResult = await scan({}, { repoRoot: tmpRoot });
    expect(scanResult.exitCode).toBe(0);

    const indexPath = path.join(tmpRoot, ".codemap", "index", "source.json");
    const originalReadFile = fs.readFile;
    let indexReads = 0;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === indexPath) {
        indexReads += 1;
        if (indexReads === 2) {
          throw new Error("simulated source index read failure");
        }
      }
      return originalReadFile(...args);
    }) as typeof fs.readFile;

    try {
      const result = await context(
        "active user",
        { sourceLimit: 1, refreshIndex: "never" },
        { repoRoot: tmpRoot },
      );

      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout!);
      expect(out.ok).toBe(true);
      expect(out.source.search.ok).toBe(false);
      expect(out.source.search.error.code).toBe("INDEX_INVALID");
      expect(out.warnings).toContain(
        "Source search failed: Error: simulated source index read failure",
      );
    } finally {
      fs.readFile = originalReadFile;
    }
  });

  test("context compact mode keeps summaries and expansion hints while trimming source detail", async () => {
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      [
        "export interface SessionUser { id: string }",
        "export function requireActiveUser(token: string): SessionUser {",
        "  const auditTrail = [",
        ...Array.from(
          { length: 80 },
          (_value, index) =>
            `    "auth audit marker ${index} requireActiveUser active user context",`,
        ),
        "  ];",
        "  return { id: auditTrail.includes(token) ? token : token };",
        "}",
      ].join("\n"),
    );

    const standardResult = await context(
      "requireActiveUser active user",
      {
        sourceLimit: 1,
        maxContentChars: 2500,
        dependencyLimit: 1,
        includeImpact: true,
      },
      { repoRoot: tmpRoot },
    );
    const compactResult = await context(
      "requireActiveUser active user",
      { mode: "compact", sourceLimit: 1 },
      { repoRoot: tmpRoot },
    );

    expect(standardResult.exitCode).toBe(0);
    expect(compactResult.exitCode).toBe(0);
    expect(compactResult.stdout!.length).toBeLessThan(
      standardResult.stdout!.length * 0.7,
    );

    const compact = JSON.parse(compactResult.stdout!);
    expect(compact.mode).toBe("compact");
    expect(compact.summary.source_hits[0]).toEqual(
      expect.objectContaining({
        file_path: "src/auth.ts",
        has_dependency_context: false,
        has_impact_context: false,
      }),
    );
    expect(compact.expansion.source_files[0]).toEqual(
      expect.objectContaining({
        file_path: "src/auth.ts",
        action: "inspect_file",
      }),
    );
    expect(compact.expansion.source_search.arguments).toEqual(
      expect.objectContaining({
        query: "requireActiveUser active user",
        include_impact: true,
        max_content_chars: 6000,
      }),
    );
    expect(compact.source.search.results[0].content.length).toBeLessThan(350);
    expect(compact.source.search.results[0].dependency_context).toEqual([]);
    expect(compact.source.search.results[0].impact_context).toBeUndefined();
  });

  test("context full mode preserves rich planning detail by default", async () => {
    const result = await context(
      "requireActiveUser",
      { mode: "full", sourceLimit: 1 },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.mode).toBe("full");
    expect(out.source.search.results[0].file_path).toBe("src/auth.ts");
    expect(out.source.search.results[0].content).toContain("requireActiveUser");
    expect(out.source.search.results[0].impact_context).toBeDefined();
    expect(out.expansion.source_search.arguments.include_impact).toBe(true);
  });

  test("context full mode expansion covers every returned node and source hit", async () => {
    const nodes: Node[] = [];
    for (let i = 0; i < 7; i += 1) {
      const filePath = `src/expansion-${i}.ts`;
      const body = `export function expansionTarget${i}() { return "expansion target ${i}"; }\n`;
      await fs.writeFile(path.join(tmpRoot, filePath), body);
      nodes.push(
        makeNode({
          id: `context/expansion-${i}`,
          name: `Expansion target ${i}`,
          summary: "Expansion target graph memory.",
          sources: [
            {
              file_path: filePath,
              line_range: [1, 1],
              content_hash: hashBuffer(Buffer.from(body)),
            },
          ],
          tags: ["expansion-target"],
          last_verified_at: new Date().toISOString(),
        }),
      );
    }
    await seed(nodes);

    const result = await context(
      "expansion target",
      { mode: "full", graphLimit: 7, sourceLimit: 7 },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.graph.nodes).toHaveLength(7);
    expect(
      out.expansion.graph_nodes.map((node: { id: string }) => node.id),
    ).toEqual(out.graph.nodes.map((node: { id: string }) => node.id));
    expect(out.source.search.results).toHaveLength(7);
    expect(
      out.expansion.source_files.map(
        (entry: { file_path: string }) => entry.file_path,
      ),
    ).toEqual(
      out.source.search.results.map(
        (result: { file_path: string }) => result.file_path,
      ),
    );
    expect(out.summary.graph_memories).toHaveLength(5);
    expect(out.summary.source_hits).toHaveLength(5);
  });

  test("context does not auto-include impact for plain underscore words", async () => {
    await fs.writeFile(
      path.join(tmpRoot, "src", "format.ts"),
      "export const note = 'file_path format';",
    );

    const result = await context(
      "file_path format",
      { sourceLimit: 1 },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.source.search.results[0].impact_context).toBeUndefined();
  });

  test("suggest-writeback reports inspected-file suggestions without writing", async () => {
    const result = await suggestWriteback(
      {
        inspectedFile: ["src/auth.ts"],
        summary: "Confirmed active user behavior invariant.",
        git: false,
      },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.evidence.inspected_files).toEqual(["src/auth.ts"]);
    expect(out.suggestions.invariants[0].source_candidates[0]).toEqual(
      expect.objectContaining({ file_path: "src/auth.ts" }),
    );

    const verify = await GraphStore.load(tmpRoot);
    expect(Object.keys(verify._data().nodes)).toEqual([]);
  });

  test("suggest-writeback can use capture session evidence", async () => {
    await captureEvent(
      "file_modified",
      {
        session: "session-a",
        anchor: ["src/auth.ts:1:4"],
      } satisfies CaptureEventFlags,
      { repoRoot: tmpRoot },
    );

    const result = await suggestWriteback(
      {
        captureSession: "session-a",
        summary: "Fixed active user review finding.",
        git: false,
      },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.evidence.capture_session).toEqual(
      expect.objectContaining({
        session_id: "session-a",
        captured_files: ["src/auth.ts"],
      }),
    );
    expect(out.suggestions.gotchas[0].source_candidates[0]).toEqual(
      expect.objectContaining({
        file_path: "src/auth.ts",
        reasons: expect.arrayContaining(["captured_modified"]),
      }),
    );
  });

  test("bin suggest-writeback accepts zero capture limit", async () => {
    await captureEvent(
      "file_modified",
      {
        session: "session-a",
        anchor: ["src/auth.ts:1:4"],
      } satisfies CaptureEventFlags,
      { repoRoot: tmpRoot },
    );

    const result = await runCodemapBin([
      "suggest-writeback",
      "--capture-session",
      "session-a",
      "--capture-limit",
      "0",
      "--summary",
      "Skip capture-backed evidence.",
      "--no-git",
    ]);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.evidence.capture_session).toEqual(
      expect.objectContaining({
        session_id: "session-a",
        total_events: 0,
        used_events: 0,
        captured_files: [],
      }),
    );
  });

  test("bin suggest-writeback uses git changed files by default", async () => {
    await runGit(["init"]);
    await runGit(["config", "user.email", "test@example.com"]);
    await runGit(["config", "user.name", "Test User"]);
    await runGit(["add", "."]);
    await runGit(["commit", "-m", "seed"]);
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      "export function requireActiveUser() { return true; }\n",
    );
    const result = await runCodemapBin([
      "suggest-writeback",
      "--summary",
      "Fixed active user review finding.",
    ]);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.evidence.git_changed_files).toEqual(["src/auth.ts"]);
    expect(out.total_suggestions).toBeGreaterThan(0);
  });

  test("bin scan rejects non-numeric max-file-bytes values", async () => {
    const result = await runCodemapBin(["scan", "--max-file-bytes", "256k"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expected a positive integer");
  });

  test("bin context rejects invalid refresh-index modes", async () => {
    const result = await runCodemapBin([
      "context",
      "active user",
      "--refresh-index",
      "sometimes",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "expected one of never, if_missing, if_stale",
    );
  });

  test("bin context rejects invalid response modes", async () => {
    const result = await runCodemapBin([
      "context",
      "active user",
      "--mode",
      "tiny",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expected one of compact, standard, full");
  });

  test("changes-context maps a dirty file to stale graph memory and likely tests", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "test"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      [
        "export function requireActiveUser(token: string) {",
        "  return { id: token };",
        "}",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(tmpRoot, "test", "auth.test.ts"),
      "import { requireActiveUser } from '../src/auth';\nrequireActiveUser('x');\n",
    );
    await scan({}, { repoRoot: tmpRoot });
    await seed([
      makeNode({
        id: "auth/active-user",
        name: "Active user invariant",
        sources: [
          {
            file_path: "src/auth.ts",
            line_range: [1, 3],
            content_hash: "sha256:old",
          },
        ],
      }),
    ]);
    await runGit(["init"]);
    await runGit(["config", "user.email", "test@example.com"]);
    await runGit(["config", "user.name", "Test User"]);
    await runGit(["add", "."]);
    await runGit(["commit", "-m", "seed"]);
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      [
        "export function requireActiveUser(token: string) {",
        "  if (!token) throw new Error('missing token');",
        "  return { id: token };",
        "}",
      ].join("\n"),
    );

    const result = await changesContext(
      { fileLimit: 5 },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.git.has_changes).toBe(true);
    expect(out.files[0]).toEqual(
      expect.objectContaining({
        file_path: "src/auth.ts",
        status: "modified",
        indexed: true,
      }),
    );
    expect(out.files[0].related_graph_nodes[0].id).toBe("auth/active-user");
    expect(out.files[0].repo_map).toEqual(
      expect.objectContaining({
        file_path: "src/auth.ts",
        rank: expect.any(Number),
      }),
    );
    expect(out.repo_map.changed_files[0].file_path).toBe("src/auth.ts");
    expect(out.stale_graph_nodes[0].id).toBe("auth/active-user");
    expect(out.likely_tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file_path: "test/auth.test.ts" }),
      ]),
    );
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Source index is stale"),
      ]),
    );
    expect(out.writeback.total_suggestions).toBeGreaterThan(0);
  });

  test("changes-context does not invent changed symbols for deletion-only hunks", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "delete_only.ts"),
      [
        "export function first() {",
        "  return 1;",
        "}",
        "export const marker = 1;",
        "const removed = 1;",
        "export function second() {",
        "  return 2;",
        "}",
      ].join("\n"),
    );
    await scan({}, { repoRoot: tmpRoot });
    await runGit(["init"]);
    await runGit(["config", "user.email", "test@example.com"]);
    await runGit(["config", "user.name", "Test User"]);
    await runGit(["add", "."]);
    await runGit(["commit", "-m", "seed"]);
    await fs.writeFile(
      path.join(tmpRoot, "src", "delete_only.ts"),
      [
        "export function first() {",
        "  return 1;",
        "}",
        "export const marker = 1;",
        "export function second() {",
        "  return 2;",
        "}",
      ].join("\n"),
    );

    const result = await changesContext(
      { fileLimit: 5 },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    if (result.stdout === undefined) throw new Error("expected stdout");
    const out = JSON.parse(result.stdout);
    const file = out.files.find(
      (entry: { file_path?: string }) =>
        entry.file_path === "src/delete_only.ts",
    );
    if (file === undefined) throw new Error("expected delete_only.ts result");
    expect(file.changed_ranges).toEqual([]);
    expect(file.changed_symbols).toEqual([]);
  });

  test("changes-context treats a single simple deletion as medium risk", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "deleted_fixture.ts"),
      "export const deletedFixture = 1;\n",
    );
    await scan({}, { repoRoot: tmpRoot });
    await runGit(["init"]);
    await runGit(["config", "user.email", "test@example.com"]);
    await runGit(["config", "user.name", "Test User"]);
    await runGit(["add", "."]);
    await runGit(["commit", "-m", "seed"]);
    await fs.rm(path.join(tmpRoot, "src", "deleted_fixture.ts"));

    const result = await changesContext(
      { fileLimit: 5 },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    if (result.stdout === undefined) throw new Error("expected stdout");
    const out = JSON.parse(result.stdout);
    expect(out.summary.risk).toBe("medium");
    expect(out.files[0]).toEqual(
      expect.objectContaining({
        file_path: "src/deleted_fixture.ts",
        deleted: true,
      }),
    );
  });

  test("generate-skills writes generated repo guidance and --check detects current", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "test"), { recursive: true });
    const authSource = [
      "export function requireActiveUser() {",
      "  return { id: 'user_123' };",
      "}",
      "export const AUTH_SCOPE = 'active-user';",
      "",
    ].join("\n");
    await fs.writeFile(path.join(tmpRoot, "src", "auth.ts"), authSource);
    await fs.writeFile(
      path.join(tmpRoot, "root.ts"),
      "export const ROOT_FLAG = true;\n",
    );
    await fs.writeFile(
      path.join(tmpRoot, "test", "auth.test.ts"),
      "import { requireActiveUser } from '../src/auth';\nrequireActiveUser();\n",
    );
    await scan({}, { repoRoot: tmpRoot });
    await seed([
      makeNode({
        id: "auth/active-user",
        kind: "invariant",
        name: "Active user invariant",
        sources: [
          {
            file_path: "src/auth.ts",
            line_range: [1, 4],
            content_hash: hashBuffer(Buffer.from(authSource)),
          },
        ],
        tags: ["src"],
        confidence: 0.95,
        last_verified_at: "2026-05-10T12:00:00Z",
      }),
    ]);
    const generated = await generateSkills({}, { repoRoot: tmpRoot });

    expect(generated.exitCode).toBe(0);
    const out = JSON.parse(generated.stdout!);
    expect(out.wrote).toBe(true);
    expect(out.generated_files).toEqual(
      expect.arrayContaining([
        ".codemap/skills/codemap-repo/SKILL.md",
        ".codemap/skills/codemap-repo/areas/root.md",
        ".codemap/skills/codemap-repo/areas/src.md",
      ]),
    );
    expect(out.summary.area_files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "src",
          file_path: ".codemap/skills/codemap-repo/areas/src.md",
          high_trust_memory: 1,
        }),
      ]),
    );
    const skillPath = path.join(tmpRoot, out.target_path);
    const body = await fs.readFile(skillPath, "utf8");
    expect(body).toContain("Generated Codemap repo context");
    expect(body).toContain("Repo Area Slices");
    expect(body).toContain("areas/root.md");
    expect(body).toContain("areas/src.md");
    expect(body).toContain("top_repo_rank");
    expect(body).toContain("changes_context");
    const rootArea = await fs.readFile(
      path.join(
        tmpRoot,
        ".codemap",
        "skills",
        "codemap-repo",
        "areas",
        "root.md",
      ),
      "utf8",
    );
    expect(rootArea).toContain("Codemap Area: root");
    expect(rootArea).toContain("root.ts");
    const hiddenRootAreaExists = await fs
      .stat(
        path.join(
          tmpRoot,
          ".codemap",
          "skills",
          "codemap-repo",
          "areas",
          ".md",
        ),
      )
      .then(
        () => true,
        () => false,
      );
    expect(hiddenRootAreaExists).toBe(false);
    const srcArea = await fs.readFile(
      path.join(
        tmpRoot,
        ".codemap",
        "skills",
        "codemap-repo",
        "areas",
        "src.md",
      ),
      "utf8",
    );
    expect(srcArea).toContain("Codemap Area: src");
    expect(srcArea).toContain("repo_rank");
    expect(srcArea).toContain("auth/active-user");
    expect(srcArea).toContain("area_hash");

    const check = await generateSkills({ check: true }, { repoRoot: tmpRoot });
    expect(check.exitCode).toBe(0);
    const checked = JSON.parse(check.stdout!);
    expect(checked.current).toBe(true);
    expect(checked.summary.area_drift).toEqual(
      expect.objectContaining({
        metadata_found: true,
        changed: [],
        removed: [],
      }),
    );
  });

  test("generate-skills --check reports area-level drift", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      "export function requireActiveUser() { return true; }\n",
    );
    await scan({}, { repoRoot: tmpRoot });
    await generateSkills({}, { repoRoot: tmpRoot });

    await fs.writeFile(
      path.join(tmpRoot, "src", "billing.ts"),
      "export function collectInvoice() { return true; }\n",
    );
    await scan({}, { repoRoot: tmpRoot });
    const check = await generateSkills({ check: true }, { repoRoot: tmpRoot });

    expect(check.exitCode).toBe(1);
    const out = JSON.parse(check.stdout!);
    expect(out.current).toBe(false);
    expect(out.summary.area_drift).toEqual(
      expect.objectContaining({
        metadata_found: true,
        changed: expect.arrayContaining(["src"]),
      }),
    );
    expect(out.next_steps.join("\n")).toContain("Changed areas: src");
  });

  test("generate-skills --check reports stale area files", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      "export function requireActiveUser() { return true; }\n",
    );
    await scan({}, { repoRoot: tmpRoot });
    await generateSkills({}, { repoRoot: tmpRoot });

    await fs.rm(
      path.join(
        tmpRoot,
        ".codemap",
        "skills",
        "codemap-repo",
        "areas",
        "src.md",
      ),
    );
    const check = await generateSkills({ check: true }, { repoRoot: tmpRoot });

    expect(check.exitCode).toBe(1);
    const out = JSON.parse(check.stdout!);
    expect(out.current).toBe(false);
    expect(out.summary.area_drift).toEqual(
      expect.objectContaining({
        metadata_found: true,
        changed: expect.arrayContaining(["src"]),
        unchanged: expect.not.arrayContaining(["src"]),
      }),
    );
    expect(out.next_steps.join("\n")).toContain("Changed areas: src");
  });

  test("benchmark-retrieval evaluates a local retrieval suite", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      "export function requireActiveUser() { return true; }\n",
    );
    await fs.writeFile(
      path.join(tmpRoot, "retrieval-suite.json"),
      JSON.stringify({
        version: 1,
        name: "CLI retrieval suite",
        queries: [
          {
            id: "auth",
            query: "require active user auth",
            expected_files: ["src/auth.ts"],
          },
        ],
      }),
    );
    await scan({}, { repoRoot: tmpRoot });

    const result = await benchmarkRetrieval(
      {
        suite: "retrieval-suite.json",
        limit: 3,
        minFileHitRate: 1,
      },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.ok).toBe(true);
    expect(out.summary.files.hit_rate_at_k).toBe(1);
    expect(out.summary.experimental.reranking).toBe("disabled");
    expect(out.summary.experimental.semantic_retrieval).toEqual(
      expect.objectContaining({
        enabled: false,
        provider: "disabled",
        provider_kind: "none",
      }),
    );
  });

  test("benchmark-retrieval supports the recall profile", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      "export function requireActiveUser() { return true; }\n",
    );
    await fs.writeFile(
      path.join(tmpRoot, "retrieval-suite.json"),
      JSON.stringify({
        version: 1,
        name: "CLI recall profile suite",
        queries: [
          {
            id: "auth",
            query: "require active user auth",
            expected_files: ["src/auth.ts"],
          },
        ],
      }),
    );
    await scan({}, { repoRoot: tmpRoot });

    const result = await benchmarkRetrieval(
      {
        suite: "retrieval-suite.json",
        profile: "recall",
      },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.summary.profile).toBe("recall");
    expect(out.summary.mode).toBe("compact");
    expect(out.summary.limit).toBe(5);
  });

  test("benchmark-retrieval enables local hash semantic experiments", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "source_index.ts"),
      "export const SOURCE_INDEX_FRESHNESS = 'search chunks symbols stale files';\n",
    );
    await fs.writeFile(
      path.join(tmpRoot, "retrieval-suite.json"),
      JSON.stringify({
        version: 1,
        name: "CLI local hash semantic suite",
        queries: [
          {
            id: "source-index-typo",
            query: "sorce indx frshness seach chunks symbols stale files",
            expected_files: ["src/source_index.ts"],
          },
        ],
      }),
    );
    await scan({}, { repoRoot: tmpRoot });

    const result = await benchmarkRetrieval(
      {
        suite: "retrieval-suite.json",
        semanticProvider: "local-hash",
      },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.summary.experimental.semantic_retrieval).toEqual(
      expect.objectContaining({
        enabled: true,
        provider: "local-hash",
        provider_kind: "local",
      }),
    );
    expect(out.summary.variants.local_vector_files.hit_rate_at_k).toBe(1);
  });

  test("benchmark-retrieval accepts payload and latency budget flags", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "src", "auth.ts"),
      "export const AUTH_SCOPE = 'active';\n",
    );
    await fs.writeFile(
      path.join(tmpRoot, "retrieval-suite.json"),
      JSON.stringify({
        version: 1,
        name: "CLI budget suite",
        queries: [
          {
            id: "auth-budget",
            query: "active auth scope",
            expected_files: ["src/auth.ts"],
          },
        ],
      }),
    );
    await scan({}, { repoRoot: tmpRoot });

    const result = await benchmarkRetrieval(
      {
        suite: "retrieval-suite.json",
        responseBudgetBytes: 10,
        minPayloadBudgetCompliance: 1,
        maxAverageResponseBytes: 1,
        maxAverageLatencyMs: 0,
      },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(1);
    const out = JSON.parse(result.stdout!);
    expect(out.summary.payload_budget.evaluated_queries).toBe(1);
    expect(out.summary.payload_budget.compliance_rate).toBe(0);
    expect(out.summary.thresholds.failed).toEqual(
      expect.arrayContaining([
        "payload_budget.compliance_rate",
        "payload_budget.average_response_bytes",
      ]),
    );
  });

  test("bin benchmark-retrieval rejects invalid threshold values", async () => {
    const result = await runCodemapBin([
      "benchmark-retrieval",
      "--min-file-hit-rate",
      "1.5",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expected a number between 0 and 1");
  });

  test("bin benchmark-retrieval rejects unavailable semantic providers", async () => {
    const result = await runCodemapBin([
      "benchmark-retrieval",
      "--semantic-provider",
      "cloud-demo",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'semantic provider must be one of "disabled", "local-hash"',
    );
  });
});

// =============================================================
// capture events CLI
// =============================================================

describe("CLI: capture events", () => {
  test("capture-event appends a redacted event without writing graph memory", async () => {
    const result = await captureEvent(
      "file_inspected",
      {
        session: "session-a",
        anchor: ["src/auth.ts:1:3"],
        text: "read auth guard with token=abc123456789",
      } satisfies CaptureEventFlags,
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.ok).toBe(true);
    expect(out.event.kind).toBe("file_inspected");
    expect(out.event.session_id).toBe("session-a");
    expect(out.event.anchors).toEqual([
      { file_path: "src/auth.ts", line_range: [1, 3] },
    ]);
    expect(out.event.payload.text).toContain("token=[redacted]");
    await expect(
      fs.stat(path.join(tmpRoot, ".codemap", "graph.json")),
    ).rejects.toThrow();
  });

  test("capture-session reports kind counts for one session", async () => {
    await captureEvent(
      "prompt",
      { session: "session-a", text: "plan the fix" },
      { repoRoot: tmpRoot },
    );
    await captureEvent(
      "codemap_call",
      { session: "session-a", tool: "query_context" },
      { repoRoot: tmpRoot },
    );
    await captureEvent(
      "file_modified",
      { session: "session-b", anchor: ["src/other.ts:1:1"] },
      { repoRoot: tmpRoot },
    );

    const result = await captureSession(
      { session: "session-a" } satisfies CaptureSessionFlags,
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.ok).toBe(true);
    expect(out.session_id).toBe("session-a");
    expect(out.total_events).toBe(2);
    expect(out.counts_by_kind.prompt).toBe(1);
    expect(out.counts_by_kind.codemap_call).toBe(1);
  });

  test("bin capture-event and capture-session wire command flags", async () => {
    const captured = await runCodemapBin([
      "capture-event",
      "file_modified",
      "--session",
      "session-a",
      "--anchor",
      "src/auth.ts:1:2",
      "--data",
      '{"reason":"dogfood"}',
    ]);

    expect(captured.exitCode).toBe(0);
    const eventOut = JSON.parse(captured.stdout);
    expect(eventOut.event.payload.reason).toBe("dogfood");

    const summarized = await runCodemapBin([
      "capture-session",
      "session-a",
      "--kind",
      "file_modified",
    ]);

    expect(summarized.exitCode).toBe(0);
    const sessionOut = JSON.parse(summarized.stdout);
    expect(sessionOut.total_events).toBe(1);
    expect(sessionOut.events[0].kind).toBe("file_modified");
  });

  test("bin capture-summary writes rebuildable summary files", async () => {
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "src", "auth.ts"), "export const auth = true;\n");
    await runCodemapBin([
      "capture-event",
      "file_modified",
      "--session",
      "session-a",
      "--anchor",
      "src/auth.ts:1:1",
    ]);

    const summarized = await runCodemapBin([
      "capture-summary",
      "session-a",
      "--exclude",
      "secrets/**",
    ]);

    expect(summarized.exitCode).toBe(0);
    const out = JSON.parse(summarized.stdout);
    expect(out.wrote_files).toBe(true);
    expect(out.sessions[0]).toEqual(
      expect.objectContaining({
        session_id: "session-a",
        total_events: 1,
      }),
    );
    await expect(
      fs.access(path.join(tmpRoot, ".codemap", "index", "capture", "sessions.json")),
    ).resolves.toBeNull();
    await expect(
      fs.access(path.join(tmpRoot, ".codemap", "index", "capture", "profile.json")),
    ).resolves.toBeNull();
  });

  test("capture-report returns a read-only JSON audit report", async () => {
    await captureEvent(
      "recall_hit",
      {
        session: "session-a",
        anchor: ["src/auth.ts:1:1"],
        data: '{"budget":{"budget_bytes":1200,"used_bytes":700,"omitted":{"graph":1}}}',
      },
      { repoRoot: tmpRoot },
    );
    await captureEvent(
      "graph_write",
      { session: "session-a", data: "{}" },
      { repoRoot: tmpRoot },
    );

    const result = await captureReport(
      { session: "session-a", json: true },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.ok).toBe(true);
    expect(out.filters.session_id).toBe("session-a");
    expect(out.totals.recall_hits).toBe(1);
    expect(out.totals.graph_writes).toBe(1);
    expect(out.budget_usage).toEqual(
      expect.objectContaining({
        total_records: 1,
        max_budget_bytes: 1200,
        max_used_bytes: 700,
        omitted_results: 1,
      }),
    );
    await expect(
      fs.access(
        path.join(tmpRoot, ".codemap", "index", "capture", "sessions.json"),
      ),
    ).rejects.toThrow();
  });

  test("bin capture-report wires session, limit, and json flags", async () => {
    await runCodemapBin([
      "capture-event",
      "prompt",
      "--session",
      "session-a",
      "--text",
      "first",
    ]);
    await runCodemapBin([
      "capture-event",
      "codemap_call",
      "--session",
      "session-a",
      "--tool",
      "query_context",
    ]);

    const reported = await runCodemapBin([
      "capture-report",
      "--session",
      "session-a",
      "--limit",
      "1",
      "--json",
    ]);

    expect(reported.exitCode).toBe(0);
    const out = JSON.parse(reported.stdout);
    expect(out.source.selected_event_count).toBe(1);
    expect(out.sessions[0].timeline[0]).toEqual(
      expect.objectContaining({
        kind: "codemap_call",
      }),
    );
  });
});

// =============================================================
// source integrity
// =============================================================

describe("source integrity", () => {
  test("generated repo guidance area ranking avoids spread-based max calls", async () => {
    const source = await readProjectSource("src/repo_guidance.ts");

    expect(source).not.toMatch(/Math\.max\(\s*\.\.\.files\.map/s);
  });

  test("generated repo guidance builds content and response metadata from one repo snapshot", async () => {
    const source = await readProjectSource("src/repo_guidance.ts");
    const countCallSites = (pattern: RegExp) =>
      source.match(pattern)?.length ?? 0;

    expect(countCallSites(/\bgetSourceIndexStatus\s*\(/g)).toBe(1);
    expect(countCallSites(/\bloadSourceIndex\s*\(/g)).toBe(1);
    expect(countCallSites(/\bGraphStore\.load\s*\(/g)).toBe(1);
  });
});

// =============================================================
// global setup
// =============================================================

describe("CLI: setup", () => {
  test("setup core writes supported client configs into a supplied home dir", async () => {
    const homeDir = path.join(tmpRoot, "home");
    const response = await setupCodemap({
      clients: ["codex", "cursor", "opencode", "claude"],
      homeDir,
      command: process.execPath,
    });

    expect(response.health.server_command_found).toBe(true);
    expect(
      response.clients.find((client) => client.client === "codex"),
    ).toEqual(expect.objectContaining({ status: "installed", changed: true }));
    expect(
      await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8"),
    ).toContain("[mcp_servers.codemap]");
    expect(
      JSON.parse(
        await fs.readFile(path.join(homeDir, ".cursor", "mcp.json"), "utf8"),
      ).mcpServers.codemap.command,
    ).toBe(process.execPath);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(homeDir, ".config", "opencode", "config.json"),
          "utf8",
        ),
      ).mcp.codemap.command,
    ).toEqual([process.execPath]);
    expect(
      response.clients.find((client) => client.client === "claude"),
    ).toEqual(
      expect.objectContaining({
        status: "manual",
        manual_command: expect.stringContaining("claude mcp add codemap"),
      }),
    );

    const check = await setupCodemap({
      clients: ["codex", "cursor", "opencode"],
      homeDir,
      command: process.execPath,
      check: true,
    });
    expect(check.clients.every((client) => client.status === "current")).toBe(
      true,
    );
  });

  test("setup capture hooks installs Codex hooks idempotently", async () => {
    const homeDir = path.join(tmpRoot, "home");
    const first = await setupCodemap({
      clients: ["codex"],
      homeDir,
      command: process.execPath,
      captureHooks: true,
      captureCommand: "codemap",
    });

    expect(first.capture_hooks).toHaveLength(1);
    expect(first.capture_hooks[0]).toEqual(
      expect.objectContaining({
        client: "codex",
        status: "installed",
        changed: true,
      }),
    );

    const hooksPath = path.join(homeDir, ".codex", "hooks.json");
    const scriptPath = path.join(
      homeDir,
      ".codex",
      "codemap",
      "capture-hook.mjs",
    );
    const hooksJson = await fs.readFile(hooksPath, "utf8");
    const script = await fs.readFile(scriptPath, "utf8");
    const hooks = JSON.parse(hooksJson);

    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "capture-hook.mjs",
    );
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain(
      "capture-hook.mjs",
    );
    expect(script).toContain("capture-event");
    expect(script).not.toContain("emit_node");
    expect(script).not.toContain("link(");

    const second = await setupCodemap({
      clients: ["codex"],
      homeDir,
      command: process.execPath,
      captureHooks: true,
      captureCommand: "codemap",
    });

    expect(second.capture_hooks[0]).toEqual(
      expect.objectContaining({
        client: "codex",
        status: "current",
        changed: false,
      }),
    );
    expect(await fs.readFile(hooksPath, "utf8")).toBe(hooksJson);
    expect(await fs.readFile(scriptPath, "utf8")).toBe(script);
  });

  test("setup capture hooks check reports missing or stale without writing", async () => {
    const homeDir = path.join(tmpRoot, "home");
    const hooksPath = path.join(homeDir, ".codex", "hooks.json");

    const missing = await setupCodemap({
      clients: ["codex"],
      homeDir,
      command: process.execPath,
      captureHooks: true,
      captureCommand: "codemap",
      check: true,
    });

    expect(missing.capture_hooks[0]).toEqual(
      expect.objectContaining({
        client: "codex",
        status: "missing",
        changed: false,
      }),
    );
    await expect(fs.access(hooksPath)).rejects.toThrow();

    await fs.mkdir(path.dirname(hooksPath), { recursive: true });
    const staleHooks = `${JSON.stringify({ hooks: { UserPromptSubmit: [] } }, null, 2)}\n`;
    await fs.writeFile(hooksPath, staleHooks, "utf8");

    const stale = await setupCodemap({
      clients: ["codex"],
      homeDir,
      command: process.execPath,
      captureHooks: true,
      captureCommand: "codemap",
      check: true,
    });

    expect(stale.capture_hooks[0]).toEqual(
      expect.objectContaining({
        client: "codex",
        status: "stale",
        changed: false,
      }),
    );
    expect(await fs.readFile(hooksPath, "utf8")).toBe(staleHooks);
  });

  test("setup capture hooks check reports stale when only the script is stale", async () => {
    const homeDir = path.join(tmpRoot, "home");
    const hooksPath = path.join(homeDir, ".codex", "hooks.json");
    const scriptPath = path.join(
      homeDir,
      ".codex",
      "codemap",
      "capture-hook.mjs",
    );
    const staleScript = "console.log('old capture hook');\n";

    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, staleScript, "utf8");

    const stale = await setupCodemap({
      clients: ["codex"],
      homeDir,
      command: process.execPath,
      captureHooks: true,
      captureCommand: "codemap",
      check: true,
    });

    expect(stale.capture_hooks[0]).toEqual(
      expect.objectContaining({
        client: "codex",
        status: "stale",
        changed: false,
      }),
    );
    await expect(fs.access(hooksPath)).rejects.toThrow();
    expect(await fs.readFile(scriptPath, "utf8")).toBe(staleScript);
  });

  test("setup capture hooks preserves unrelated Codex hooks and backs up stale config", async () => {
    const homeDir = path.join(tmpRoot, "home");
    const hooksPath = path.join(homeDir, ".codex", "hooks.json");
    await fs.mkdir(path.dirname(hooksPath), { recursive: true });
    const existingHooks = `${JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo keep-me",
                  statusMessage: "Existing hook",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(hooksPath, existingHooks, "utf8");

    const result = await setupCodemap({
      clients: ["codex"],
      homeDir,
      command: process.execPath,
      captureHooks: true,
      captureCommand: "codemap",
    });

    expect(result.capture_hooks[0]).toEqual(
      expect.objectContaining({
        client: "codex",
        status: "updated",
        changed: true,
        backup_path: `${hooksPath}.codemap-backup`,
      }),
    );
    expect(await fs.readFile(`${hooksPath}.codemap-backup`, "utf8")).toBe(
      existingHooks,
    );

    const hooks = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    expect(hooks.hooks.Stop).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hooks: [
            expect.objectContaining({
              command: "echo keep-me",
            }),
          ],
        }),
      ]),
    );
    expect(
      hooks.hooks.Stop.filter((group: { hooks?: Array<{ command?: string }> }) =>
        group.hooks?.some((hook) => hook.command?.includes("capture-hook.mjs")),
      ),
    ).toHaveLength(1);
  });

  test("setup capture hooks dry run reports planned writes without touching files", async () => {
    const homeDir = path.join(tmpRoot, "home");
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const hooksPath = path.join(homeDir, ".codex", "hooks.json");
    const scriptPath = path.join(
      homeDir,
      ".codex",
      "codemap",
      "capture-hook.mjs",
    );

    const dryRun = await setupCodemap({
      clients: ["codex"],
      homeDir,
      command: process.execPath,
      captureHooks: true,
      captureCommand: "codemap",
      dryRun: true,
    });

    expect(dryRun.clients[0]).toEqual(
      expect.objectContaining({
        client: "codex",
        status: "planned",
        changed: false,
      }),
    );
    expect(dryRun.capture_hooks[0]).toEqual(
      expect.objectContaining({
        client: "codex",
        status: "planned",
        changed: false,
      }),
    );
    await expect(fs.access(configPath)).rejects.toThrow();
    await expect(fs.access(hooksPath)).rejects.toThrow();
    await expect(fs.access(scriptPath)).rejects.toThrow();
  });

  test("setup health reports generated guidance freshness when a repo root is supplied", async () => {
    const homeDir = path.join(tmpRoot, "home");
    await init({ force: true }, { repoRoot: tmpRoot });

    const current = await setupCodemap({
      clients: ["codex"],
      homeDir,
      command: process.execPath,
      repoRoot: tmpRoot,
      check: true,
    });
    expect(current.health.guidance).toEqual(
      expect.objectContaining({
        checked: true,
        status: "current",
      }),
    );
    expect(current.health.guidance.files[0]).toEqual(
      expect.objectContaining({
        file: "AGENTS.md",
        status: "current",
      }),
    );

    await fs.writeFile(path.join(tmpRoot, "AGENTS.md"), "stale guidance\n");
    const stale = await setupCodemap({
      clients: ["codex"],
      homeDir,
      command: process.execPath,
      repoRoot: tmpRoot,
      check: true,
    });
    expect(stale.health.guidance.status).toBe("stale");
    expect(stale.warnings.join("\n")).toContain("guidance");

    const cli = await setup(
      { check: true, command: process.execPath },
      {
        repoRoot: tmpRoot,
      },
    );
    const parsed = JSON.parse(cli.stdout!);
    expect(parsed.health.guidance.status).toBe("stale");

    await fs.rm(path.join(tmpRoot, "AGENTS.md"), {
      force: true,
      recursive: true,
    });
    await fs.mkdir(path.join(tmpRoot, "AGENTS.md"));
    const error = await setupCodemap({
      clients: ["codex"],
      homeDir,
      command: process.execPath,
      repoRoot: tmpRoot,
      check: true,
    });
    expect(error.health.guidance.status).toBe("error");
    expect(error.warnings.join("\n")).toContain(
      "Generated guidance could not be checked",
    );
    expect(error.warnings.join("\n")).not.toContain("codemap init --check");
  });

  test("setup --check --force is rejected before touching real client config", async () => {
    const result = await setup({ check: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--check is read-only");
  });
});
