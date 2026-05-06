import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraphStore } from "../../src/graph.js";
import {
  clearSourceIndex,
  getSourceIndexStatus,
  loadSourceIndex,
  scanSourceIndex,
  searchSourceIndex,
  sourceIndexPath,
} from "../../src/source_index.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemap-source-index-"));
  await write(
    "src/auth.ts",
    [
      "import { createClient } from './db';",
      "",
      "export interface SessionUser {",
      "  id: string;",
      "}",
      "",
      "export function requireActiveUser(token: string): SessionUser {",
      "  return { id: token };",
      "}",
    ].join("\n"),
  );
  await write(
    "src/payment.ts",
    [
      "export const createCheckoutSession = async (userId: string) => {",
      "  return { id: userId };",
      "};",
    ].join("\n"),
  );
  await write(
    "node_modules/ignored.ts",
    "export function ignored() {}",
  );
  await write("dist/generated.js", "export function generated() {}");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function write(filePath: string, content: string): Promise<void> {
  const absolutePath = path.join(tmpRoot, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

describe("source index", () => {
  test("scan builds a rebuildable index for supported source files", async () => {
    const index = await scanSourceIndex(tmpRoot);

    expect(index.stats.files_indexed).toBe(2);
    expect(index.stats.files_skipped).toBeGreaterThan(0);
    expect(index.files["src/auth.ts"]?.symbols.map((s) => s.name)).toEqual([
      "SessionUser",
      "requireActiveUser",
    ]);
    expect(index.files["src/payment.ts"]?.symbols.map((s) => s.name)).toEqual([
      "createCheckoutSession",
    ]);
    expect(index.files["node_modules/ignored.ts"]).toBeUndefined();
    expect(index.files["dist/generated.js"]).toBeUndefined();

    const reloaded = await loadSourceIndex(tmpRoot);
    expect(reloaded?.stats.chunks_indexed).toBe(4);
    expect(reloaded?.search.document_count).toBe(4);
    expect(reloaded?.search.postings.require).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunk_id: "src/auth.ts:7-9",
          term_frequency: expect.any(Number),
        }),
      ]),
    );
  });

  test("search ranks symbol and path matches above unrelated chunks", async () => {
    await scanSourceIndex(tmpRoot);

    const response = await searchSourceIndex(tmpRoot, "active user auth", {
      limit: 2,
    });

    expect(response.ok).toBe(true);
    expect(response.results[0]?.file_path).toBe("src/auth.ts");
    expect(response.results[0]?.symbols.map((s) => s.name)).toContain(
      "requireActiveUser",
    );
  });

  test("search explains source matches with score breakdowns", async () => {
    await scanSourceIndex(tmpRoot);

    const response = await searchSourceIndex(tmpRoot, "requireActiveUser db auth", {
      limit: 1,
    });
    const result = response.results[0];

    expect(result?.file_path).toBe("src/auth.ts");
    expect(result?.score_breakdown.symbol).toBeGreaterThan(0);
    expect(result?.score_breakdown.path).toBeGreaterThan(0);
    expect(result?.score_breakdown.import).toBeGreaterThan(0);
    expect(result?.score_breakdown.bm25).toBeGreaterThan(0);
    expect(result?.match_reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "bm25" }),
        expect.objectContaining({ field: "symbol", value: "requireActiveUser" }),
        expect.objectContaining({ field: "path", value: "src/auth.ts" }),
        expect.objectContaining({ field: "import", value: "./db" }),
      ]),
    );
    expect(result?.match_reasons.find((reason) => reason.field === "bm25")?.score).toBe(
      result?.score_breakdown.bm25,
    );
  });

  test("search explains export matches", async () => {
    await scanSourceIndex(tmpRoot);

    const response = await searchSourceIndex(
      tmpRoot,
      "createCheckoutSession payment",
      { limit: 1 },
    );
    const result = response.results[0];

    expect(result?.file_path).toBe("src/payment.ts");
    expect(result?.score_breakdown.export).toBeGreaterThan(0);
    expect(result?.match_reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "export",
          value: "createCheckoutSession",
        }),
      ]),
    );
  });

  test("search diversifies top results across files before filling repeats", async () => {
    await write(
      "src/auth-many.ts",
      [
        "export function needleAlpha() { return 'needle auth alpha'; }",
        "export function needleBeta() { return 'needle auth beta'; }",
        "export function needleGamma() { return 'needle auth gamma'; }",
      ].join("\n"),
    );
    await write(
      "src/billing-needle.ts",
      "export function needleBilling() { return 'needle billing'; }",
    );

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "needle", { limit: 3 });

    expect(response.results).toHaveLength(3);
    expect(
      new Set(response.results.slice(0, 2).map((result) => result.file_path)),
    ).toEqual(new Set(["src/auth-many.ts", "src/billing-needle.ts"]));
  });

  test("search total_results reports matches beyond the returned limit", async () => {
    await write("src/needle-a.ts", "export function sharedNeedleAlpha() {}");
    await write("src/needle-b.ts", "export function sharedNeedleBeta() {}");
    await write("src/needle-c.ts", "export function sharedNeedleGamma() {}");

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "shared needle", {
      limit: 2,
    });

    expect(response.results).toHaveLength(2);
    expect(response.total_results).toBe(3);
  });

  test("repeated searches reuse persisted search statistics with stable counts and timing", async () => {
    for (let index = 0; index < 30; index += 1) {
      await write(
        `src/generated-search-${index}.ts`,
        `export function generatedSearch${index}() { return 'needle ${index}'; }`,
      );
    }

    await scanSourceIndex(tmpRoot);
    const first = await searchSourceIndex(tmpRoot, "generated search needle", {
      limit: 5,
    });
    const second = await searchSourceIndex(tmpRoot, "generated search needle", {
      limit: 5,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.total_results).toBe(second.total_results);
    expect(first.results.map((result) => result.file_path)).toEqual(
      second.results.map((result) => result.file_path),
    );
    expect(Number.isFinite(first.search_time_ms)).toBe(true);
    expect(Number.isFinite(second.search_time_ms)).toBe(true);
  });

  test("scan reports files skipped by source-index filters", async () => {
    await write("src/readme.md", "not a supported source extension");
    await write("src/client.generated.ts", "export function generated() {}");
    await write("src/huge.ts", "x".repeat(257 * 1024));

    const index = await scanSourceIndex(tmpRoot);

    expect(index.files["src/readme.md"]).toBeUndefined();
    expect(index.files["src/client.generated.ts"]).toBeUndefined();
    expect(index.files["src/huge.ts"]).toBeUndefined();
    expect(index.stats.files_skipped).toBeGreaterThanOrEqual(3);
  });

  test("search returns related graph nodes for matching source files", async () => {
    await scanSourceIndex(tmpRoot);
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode({
      id: "auth/session-user",
      kind: "invariant",
      name: "Session user invariant",
      summary: "requireActiveUser returns an active session user.",
      sources: [
        {
          file_path: "src/auth.ts",
          line_range: [7, 9],
          content_hash: "sha256:placeholder",
        },
      ],
      tags: ["auth"],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: "2026-04-28T00:00:00Z",
    });
    await store.save();

    const response = await searchSourceIndex(tmpRoot, "session user", {
      limit: 1,
    });

    expect(response.results[0]?.related_nodes[0]?.id).toBe("auth/session-user");
  });

  test("search deduplicates related graph nodes with multiple same-file anchors", async () => {
    await scanSourceIndex(tmpRoot);
    const store = await GraphStore.load(tmpRoot);
    store.upsertNode({
      id: "auth/multi-anchor",
      kind: "decision",
      name: "Multi-anchor auth node",
      summary: "One graph node may cite the same source file more than once.",
      sources: [
        {
          file_path: "src/auth.ts",
          line_range: [1, 3],
          content_hash: "sha256:placeholder",
        },
        {
          file_path: "src/auth.ts",
          line_range: [7, 9],
          content_hash: "sha256:placeholder",
        },
      ],
      tags: ["auth"],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: "2026-04-28T00:00:00Z",
    });
    await store.save();

    const response = await searchSourceIndex(tmpRoot, "multi anchor auth", {
      limit: 1,
    });

    const relatedIds = response.results[0]?.related_nodes.map((n) => n.id);
    expect(relatedIds).toEqual(["auth/multi-anchor"]);
  });

  test("search can include dependency context for imports and importers", async () => {
    await write(
      "src/db.ts",
      [
        "export function createClient() {",
        "  return { id: 'db' };",
        "}",
      ].join("\n"),
    );
    await write(
      "src/consumer.ts",
      [
        "import { requireActiveUser } from './auth';",
        "",
        "export function consumeAuth(token: string) {",
        "  return requireActiveUser(token);",
        "}",
      ].join("\n"),
    );

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "requireActiveUser auth", {
      limit: 5,
      dependencyLimit: 4,
    });
    const authResult = response.results.find(
      (result) => result.file_path === "src/auth.ts",
    );

    expect(authResult).toBeDefined();
    expect(authResult?.dependency_context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "imports",
          file_path: "src/db.ts",
          module: "./db",
        }),
        expect.objectContaining({
          direction: "imported_by",
          file_path: "src/consumer.ts",
          module: "./auth",
        }),
      ]),
    );
  });

  test("dependency context deduplicates repeated imports of the same file", async () => {
    await write(
      "src/db.ts",
      [
        "export const foo = 1;",
        "export const bar = 2;",
      ].join("\n"),
    );
    await write(
      "src/auth.ts",
      [
        "import { foo } from './db';",
        "import { bar } from './db';",
        "",
        "export function repeatedAuthImports() {",
        "  return foo + bar;",
        "}",
      ].join("\n"),
    );
    await write(
      "src/consumer.ts",
      [
        "import { repeatedAuthImports } from './auth';",
        "import { repeatedAuthImports as again } from './auth';",
        "",
        "export function consumeRepeatedAuth() {",
        "  return repeatedAuthImports() + again();",
        "}",
      ].join("\n"),
    );

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "repeated auth imports", {
      limit: 3,
      dependencyLimit: 4,
    });
    const authResult = response.results.find(
      (result) => result.file_path === "src/auth.ts",
    );

    expect(
      authResult?.dependency_context.filter(
        (dependency) =>
          dependency.direction === "imports" &&
          dependency.file_path === "src/db.ts",
      ),
    ).toHaveLength(1);
    expect(
      authResult?.dependency_context.filter(
        (dependency) =>
          dependency.direction === "imported_by" &&
          dependency.file_path === "src/consumer.ts",
      ),
    ).toHaveLength(1);
  });

  test("dependency context resolves emitted .js specifiers back to TypeScript sources", async () => {
    await write(
      "src/runtime.ts",
      [
        "import { healthCheck } from './health.js';",
        "",
        "export function runHealth() {",
        "  return healthCheck();",
        "}",
      ].join("\n"),
    );
    await write(
      "src/health.ts",
      [
        "export function healthCheck() {",
        "  return true;",
        "}",
      ].join("\n"),
    );

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "run health", {
      limit: 3,
      dependencyLimit: 2,
    });
    const runtimeResult = response.results.find(
      (result) => result.file_path === "src/runtime.ts",
    );

    expect(runtimeResult?.dependency_context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "imports",
          file_path: "src/health.ts",
          module: "./health.js",
        }),
      ]),
    );
  });

  test("search can include symbol impact context", async () => {
    await write(
      "src/auth.ts",
      [
        "// auth module preamble",
        "import { createClient } from './db';",
        "",
        "export interface SessionUser {",
        "  id: string;",
        "}",
        "",
        "export function requireActiveUser(token: string): SessionUser {",
        "  return { id: token };",
        "}",
      ].join("\n"),
    );
    await write(
      "src/db.ts",
      [
        "export function createClient() {",
        "  return { id: 'db' };",
        "}",
      ].join("\n"),
    );
    await write(
      "src/consumer.ts",
      [
        "import { requireActiveUser } from './auth';",
        "",
        "export function consumeAuth(token: string) {",
        "  return requireActiveUser(token);",
        "}",
      ].join("\n"),
    );
    await write(
      "src/auth-index.ts",
      "export { requireActiveUser } from './auth';",
    );

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "requireActiveUser", {
      limit: 5,
      includeImpact: true,
      impactLimit: 4,
    });
    const authResult = response.results.find(
      (result) => result.file_path === "src/auth.ts",
    );

    expect(authResult?.impact_context?.target).toEqual(
      expect.objectContaining({
        type: "symbol",
        value: "requireActiveUser",
        file_path: "src/auth.ts",
        ambiguous: false,
      }),
    );
    expect(authResult?.impact_context?.definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "definition",
          precision: "exact",
          file_path: "src/auth.ts",
          symbol: expect.objectContaining({ name: "requireActiveUser" }),
        }),
      ]),
    );
    expect(authResult?.impact_context?.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "import",
          precision: "exact",
          file_path: "src/db.ts",
          start_line: 1,
          end_line: 1,
          import_line: 2,
          module: "./db",
        }),
      ]),
    );
    expect(authResult?.impact_context?.imported_by).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "imported_by",
          precision: "exact",
          file_path: "src/auth-index.ts",
          module: "./auth",
        }),
        expect.objectContaining({
          kind: "imported_by",
          precision: "exact",
          file_path: "src/consumer.ts",
          module: "./auth",
        }),
      ]),
    );
    expect(authResult?.impact_context?.likely_affected_files).toContain(
      "src/consumer.ts",
    );
    expect(authResult?.impact_context?.approximate_references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "text_reference",
          precision: "approximate",
          file_path: "src/consumer.ts",
        }),
      ]),
    );
  });

  test("impact context supports file targets", async () => {
    await write(
      "src/db.ts",
      "export function createClient() { return { id: 'db' }; }",
    );
    await write(
      "src/consumer.ts",
      [
        "import { requireActiveUser } from './auth';",
        "export const consume = requireActiveUser;",
      ].join("\n"),
    );

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "src/auth.ts", {
      limit: 1,
      includeImpact: true,
      impactLimit: 3,
    });

    expect(response.results[0]?.impact_context?.target).toEqual(
      expect.objectContaining({
        type: "file",
        value: "src/auth.ts",
        file_path: "src/auth.ts",
      }),
    );
    expect(response.results[0]?.impact_context?.imports[0]?.file_path).toBe(
      "src/db.ts",
    );
    expect(response.results[0]?.impact_context?.imported_by[0]?.file_path).toBe(
      "src/consumer.ts",
    );
  });

  test("impact context marks ambiguous symbol names", async () => {
    await write(
      "src/admin.ts",
      [
        "export function requireActiveUser(token: string) {",
        "  return { id: token, role: 'admin' };",
        "}",
      ].join("\n"),
    );

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "requireActiveUser", {
      limit: 5,
      includeImpact: true,
      impactLimit: 5,
    });
    const authResult = response.results.find(
      (result) => result.file_path === "src/auth.ts",
    );

    expect(authResult?.impact_context?.target.ambiguous).toBe(true);
    expect(
      authResult?.impact_context?.definitions.map((entry) => entry.file_path),
    ).toEqual(["src/admin.ts", "src/auth.ts"]);
    expect(authResult?.impact_context?.warnings[0]).toContain(
      "multiple indexed definitions",
    );
  });

  test("scan keeps preamble content before the first detected symbol searchable", async () => {
    await write(
      "src/preamble.ts",
      [
        "/**",
        " * Handshake sentinel lives before the first exported function.",
        " */",
        "const SCHEMA_VERSION = 1;",
        "",
        "export function afterPreamble() {",
        "  return SCHEMA_VERSION;",
        "}",
      ].join("\n"),
    );

    await scanSourceIndex(tmpRoot);
    const response = await searchSourceIndex(tmpRoot, "handshake sentinel", {
      limit: 1,
    });

    expect(response.results[0]?.file_path).toBe("src/preamble.ts");
    expect(response.results[0]?.chunk_type).toBe("mixed");
    expect(response.results[0]?.content).toContain("SCHEMA_VERSION");
  });

  test("status reports fresh, stale, missing, and new files", async () => {
    await scanSourceIndex(tmpRoot);
    expect((await getSourceIndexStatus(tmpRoot)).fresh).toBe(true);

    await write("src/auth.ts", "export function changedAuth() {}");
    await write("src/new.ts", "export function newThing() {}");
    await fs.rm(path.join(tmpRoot, "src/payment.ts"));

    const status = await getSourceIndexStatus(tmpRoot);
    expect(status.stale_files).toBe(1);
    expect(status.missing_files).toBe(1);
    expect(status.new_files).toBe(1);
    expect(status.fresh).toBe(false);
  });

  test("status uses the max file size recorded during scan", async () => {
    await write(
      "src/large.ts",
      `export function largeSource() {}\n${"x".repeat(300 * 1024)}`,
    );

    const index = await scanSourceIndex(tmpRoot, {
      maxFileBytes: 512 * 1024,
    });
    expect(index.max_file_bytes).toBe(512 * 1024);
    expect(index.files["src/large.ts"]).toBeDefined();

    const status = await getSourceIndexStatus(tmpRoot);
    expect(status.missing_files).toBe(0);
    expect(status.fresh).toBe(true);
  });

  test("status detects a missing search-ready snapshot without reading source content", async () => {
    await scanSourceIndex(tmpRoot);
    const indexPath = sourceIndexPath(tmpRoot);
    const raw = JSON.parse(await fs.readFile(indexPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete raw.search;
    await fs.writeFile(indexPath, `${JSON.stringify(raw, null, 2)}\n`);

    const status = await getSourceIndexStatus(tmpRoot);
    expect(status.search_indexed).toBe(false);
    expect(status.search_index_stale).toBe(true);
    expect(status.fresh).toBe(false);

    const response = await searchSourceIndex(tmpRoot, "active user auth", {
      limit: 1,
    });
    expect(response.ok).toBe(true);
    expect(response.results[0]?.file_path).toBe("src/auth.ts");
    expect(response.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("search snapshot is stale or missing"),
      ]),
    );
  });

  test("clear removes the source index cache", async () => {
    await scanSourceIndex(tmpRoot);
    expect(await loadSourceIndex(tmpRoot)).not.toBeNull();

    await clearSourceIndex(tmpRoot);
    expect(await loadSourceIndex(tmpRoot)).toBeNull();
  });
});
