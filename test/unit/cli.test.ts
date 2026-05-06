import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraphStore } from "../../src/graph.js";
import { clearIndex } from "../../src/cli/clear_index.js";
import { context } from "../../src/cli/context.js";
import { correct } from "../../src/cli/correct.js";
import { deprecate } from "../../src/cli/deprecate.js";
import { doctor } from "../../src/cli/doctor.js";
import { indexStatus } from "../../src/cli/index_status.js";
import { init } from "../../src/cli/init.js";
import { rollup } from "../../src/cli/rollup.js";
import { scan } from "../../src/cli/scan.js";
import { searchSource } from "../../src/cli/search_source.js";
import { show } from "../../src/cli/show.js";
import { validate } from "../../src/cli/validate.js";
import {
  GUIDANCE_POLICY_HASH,
  SERVER_INSTRUCTIONS,
} from "../../src/instructions.js";
import type { Node } from "../../src/types.js";

let tmpRoot: string;

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

async function seed(nodes: Node[], edges: Array<[string, string, string, string?]> = []): Promise<void> {
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
  const projectRoot = path.resolve(import.meta.dir, "../..");
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
    await seed([
      makeNode({ id: "a/canonical", aliases: ["the-alias"] }),
    ]);
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
    const r = await correct(
      "a/x",
      { confidence: 1.5 },
      { repoRoot: tmpRoot },
    );
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stderr!).error.code).toBe("INVALID_FLAG");
  });

  test("scalar: --confidence rejects out-of-range value (-)", async () => {
    await seed([makeNode({ id: "a/x" })]);
    const r = await correct(
      "a/x",
      { confidence: -0.1 },
      { repoRoot: tmpRoot },
    );
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
    const r = await correct(
      "missing",
      { summary: "x" },
      { repoRoot: tmpRoot },
    );
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
    const r = await correct(
      "any",
      { summary: "x" },
      { repoRoot: tmpRoot },
    );
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
    const after = new Date(
      verify.getNode("a/x")!.last_verified_at,
    ).getTime();
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
    await seed([
      makeNode({ id: "a/x", summary: "Original behavior." }),
    ]);
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

    const written = await fs.readFile(
      path.join(tmpRoot, "AGENTS.md"),
      "utf8",
    );
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
    const written = await fs.readFile(
      path.join(projDir, "AGENTS.md"),
      "utf8",
    );
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
    const after = await fs.readFile(
      path.join(tmpRoot, "AGENTS.md"),
      "utf8",
    );
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
    const after = await fs.readFile(
      path.join(tmpRoot, "AGENTS.md"),
      "utf8",
    );
    expect(after).toContain(SERVER_INSTRUCTIONS);
  });

  test("--claude writes both AGENTS.md and CLAUDE.md", async () => {
    const r = await init({ claude: true }, { repoRoot: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("wrote AGENTS.md");
    expect(r.stdout).toContain("wrote CLAUDE.md");
    const agents = await fs.readFile(
      path.join(tmpRoot, "AGENTS.md"),
      "utf8",
    );
    const claude = await fs.readFile(
      path.join(tmpRoot, "CLAUDE.md"),
      "utf8",
    );
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
    await fs.writeFile(
      path.join(tmpRoot, "AGENTS.md"),
      "preexisting",
      "utf8",
    );
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

  test("context builds a missing source index by default", async () => {
    const result = await context(
      "active user",
      { sourceLimit: 1 },
      { repoRoot: tmpRoot },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout!);
    expect(out.ok).toBe(true);
    expect(out.source.refreshed).toBe(true);
    expect(out.source.status.indexed).toBe(true);
    expect(out.source.search.results[0].file_path).toBe("src/auth.ts");
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

  test("bin scan rejects non-numeric max-file-bytes values", async () => {
    const result = await runCodemapBin([
      "scan",
      "--max-file-bytes",
      "256k",
    ]);

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
    expect(result.stderr).toContain("expected one of never, if_missing, if_stale");
  });
});
