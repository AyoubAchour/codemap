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
    expect(reloaded?.search).toBeDefined();
    expect(reloaded?.search?.document_count).toBe(4);
    expect(reloaded?.search?.postings.require).toEqual(
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

  test("search can reuse a preloaded source index", async () => {
    const sourceIndex = await scanSourceIndex(tmpRoot);
    await clearSourceIndex(tmpRoot);

    const response = await searchSourceIndex(tmpRoot, "active user auth", {
      limit: 1,
      sourceIndex,
    });

    expect(response.ok).toBe(true);
    expect(response.results[0]?.file_path).toBe("src/auth.ts");
    expect(await loadSourceIndex(tmpRoot)).toBeNull();
  });

  test("scan uses AST extraction for TS and JS module shapes", async () => {
    await write(
      "src/module-shapes.tsx",
      [
        "import React from 'react';",
        "const LOCAL_VERSION = 1;",
        "export default class DefaultWidget {}",
        "const localThing = () => LOCAL_VERSION;",
        "export { localThing as renamedThing };",
        "export { externalThing } from './external';",
        "export * from './star';",
        "export async function loadLazy() {",
        "  return import('./lazy');",
        "}",
      ].join("\n"),
    );
    await write(
      "src/runtime.js",
      [
        "const legacy = require('./legacy');",
        "export default function runtimeEntry() {",
        "  return legacy;",
        "}",
      ].join("\n"),
    );

    const index = await scanSourceIndex(tmpRoot);
    const moduleShapes = index.files["src/module-shapes.tsx"];
    const runtime = index.files["src/runtime.js"];

    expect(moduleShapes?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "LOCAL_VERSION",
          kind: "const",
          line: 2,
          end_line: 2,
        }),
        expect.objectContaining({
          name: "DefaultWidget",
          kind: "class",
          exported: true,
        }),
        expect.objectContaining({
          name: "loadLazy",
          kind: "function",
          exported: true,
        }),
      ]),
    );
    expect(moduleShapes?.exports).toEqual([
      "default",
      "externalThing",
      "loadLazy",
      "renamedThing",
    ]);
    expect(moduleShapes?.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: "react", line: 1, end_line: 1 }),
        expect.objectContaining({ module: "./external", line: 6, end_line: 6 }),
        expect.objectContaining({ module: "./star", line: 7, end_line: 7 }),
        expect.objectContaining({ module: "./lazy", line: 9, end_line: 9 }),
      ]),
    );
    expect(runtime?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "runtimeEntry", exported: true }),
      ]),
    );
    expect(runtime?.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: "./legacy", line: 1, end_line: 1 }),
      ]),
    );
  });

  test("impact references skip decorated definitions and preview exact lines", async () => {
    await write(
      "src/decorated.ts",
      [
        "function Injectable(): ClassDecorator {",
        "  return () => undefined;",
        "}",
        "",
        "@Injectable()",
        "export class DecoratedService {",
        "  run() {",
        "    return 'ok';",
        "  }",
        "}",
      ].join("\n"),
    );
    await write(
      "src/decorated-consumer.ts",
      [
        "import { DecoratedService } from './decorated';",
        "",
        "export function consumeDecorated(",
        "  service: DecoratedService,",
        ") {",
        "  const first = service.run();",
        "  const second = service.run();",
        "  return first + ':' + second;",
        "}",
      ].join("\n"),
    );

    const index = await scanSourceIndex(tmpRoot);
    const decoratedSymbol = index.files["src/decorated.ts"]?.symbols.find(
      (symbol) => symbol.name === "DecoratedService",
    );

    expect(decoratedSymbol).toEqual(
      expect.objectContaining({
        name: "DecoratedService",
        line: 5,
        name_line: 6,
        end_line: 10,
      }),
    );

    const response = await searchSourceIndex(tmpRoot, "DecoratedService", {
      limit: 5,
      includeImpact: true,
      impactLimit: 5,
    });
    const result = response.results.find(
      (entry) => entry.file_path === "src/decorated.ts",
    );
    const approximateReferences =
      result?.impact_context?.approximate_references ?? [];

    expect(approximateReferences).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_path: "src/decorated.ts",
          start_line: 6,
          reason: "identifier reference mentions DecoratedService",
        }),
      ]),
    );

    const consumerReference = approximateReferences.find(
      (reference) =>
        reference.file_path === "src/decorated-consumer.ts" &&
        reference.reason === "identifier reference mentions DecoratedService",
    );

    expect(consumerReference).toEqual(
      expect.objectContaining({
        start_line: 4,
        end_line: 4,
        content_preview: "  service: DecoratedService,",
      }),
    );
    expect(consumerReference?.content_preview).not.toContain("const first");
  });

  test("scan falls back to regex extraction when AST parsing fails", async () => {
    await write(
      "src/broken.ts",
      [
        "import { dependency } from './dep';",
        "export function stillIndexed(",
      ].join("\n"),
    );

    const index = await scanSourceIndex(tmpRoot);
    const broken = index.files["src/broken.ts"];

    expect(broken?.imports).toEqual([
      expect.objectContaining({ module: "./dep", line: 1, end_line: 1 }),
    ]);
    expect(broken?.exports).toContain("stillIndexed");
    expect(broken?.symbols).toEqual([
      expect.objectContaining({
        name: "stillIndexed",
        kind: "function",
        line: 2,
        end_line: 2,
      }),
    ]);
    expect(broken?.references).toEqual([]);
  });

  test("scan caps stored AST identifier references per file", async () => {
    await write(
      "src/reference-heavy.ts",
      [
        "export function referenceHeavy() {",
        ...Array.from(
          { length: 2500 },
          (_, index) => `  returnValue${index};`,
        ),
        "}",
      ].join("\n"),
    );

    const index = await scanSourceIndex(tmpRoot);
    const heavy = index.files["src/reference-heavy.ts"];

    expect(heavy?.references?.length).toBe(2000);
    expect(heavy?.references_truncated).toBe(true);
    expect(heavy?.references?.at(-1)).toEqual(
      expect.objectContaining({
        start_line: 2001,
        end_line: 2001,
      }),
    );
  });

  test("scan excludes destructuring binding names from AST references", async () => {
    await write(
      "src/destructuring.ts",
      [
        "export function readOptions(opts: { source: string }) {",
        "  const { source: localAlias } = opts;",
        "  return opts.source;",
        "}",
      ].join("\n"),
    );

    const index = await scanSourceIndex(tmpRoot);
    const destructuring = index.files["src/destructuring.ts"];

    expect(
      destructuring?.references?.some(
        (reference) => reference.name === "localAlias",
      ),
    ).toBe(false);
  });

  test("scan excludes accessor and named function expression names from AST references", async () => {
    await write(
      "src/accessors.ts",
      [
        "class Account {",
        "  get id() {",
        "    return 'account';",
        "  }",
        "  set id(value: string) {",
        "    this.write(value);",
        "  }",
        "  write(value: string) {",
        "    return value;",
        "  }",
        "}",
        "const handler = function namedHandler() {",
        "  return new Account();",
        "};",
      ].join("\n"),
    );

    const index = await scanSourceIndex(tmpRoot);
    const accessors = index.files["src/accessors.ts"];

    expect(
      accessors?.references?.some((reference) => reference.name === "id"),
    ).toBe(false);
    expect(
      accessors?.references?.some(
        (reference) => reference.name === "namedHandler",
      ),
    ).toBe(false);
  });

  test("scan excludes property access names from AST references", async () => {
    await write(
      "src/property-access.ts",
      [
        "export function update(values: string[], formatter: { format(value: string): string }) {",
        "  values.push(formatter.format('x'));",
        "  return values.map((value) => value.trim());",
        "}",
      ].join("\n"),
    );

    const index = await scanSourceIndex(tmpRoot);
    const propertyAccess = index.files["src/property-access.ts"];

    for (const name of ["push", "format", "map", "trim"]) {
      expect(
        propertyAccess?.references?.some((reference) => reference.name === name),
      ).toBe(false);
    }
  });

  test("scan excludes enum members and named class expressions from AST references", async () => {
    await write(
      "src/declaration-names.ts",
      [
        "enum Status {",
        "  Active,",
        "  Inactive,",
        "}",
        "const Widget = class NamedWidget {};",
        "export function read(status: Status) {",
        "  return Status.Active;",
        "}",
      ].join("\n"),
    );

    const index = await scanSourceIndex(tmpRoot);
    const declarations = index.files["src/declaration-names.ts"];

    for (const name of ["Active", "Inactive", "NamedWidget"]) {
      expect(
        declarations?.references?.some((reference) => reference.name === name),
      ).toBe(false);
    }
  });

  test("impact fallback still runs when dedupe lowers capped reference count", async () => {
    const duplicateLines = Array.from(
      { length: 1100 },
      () => "  repeatedValue; repeatedValue;",
    );
    const sourceLines = [
      "export function firstTargetUse() {",
      "  targetSymbol();",
      "}",
      "",
      "export function noisyReferences() {",
      ...duplicateLines,
      "}",
      "",
      "export function lateTargetUse() {",
      "  targetSymbol();",
      "}",
      "",
      "export function targetSymbol() {",
      "  return 1;",
      "}",
    ];
    const lateTargetLine =
      sourceLines.findIndex(
        (line, index) => index > 10 && line === "  targetSymbol();",
      ) + 1;

    await write("src/deduped-capped-references.ts", sourceLines.join("\n"));

    const index = await scanSourceIndex(tmpRoot);
    const capped = index.files["src/deduped-capped-references.ts"];

    expect(capped?.references_truncated).toBe(true);
    expect(capped?.references?.length).toBeLessThan(2000);
    expect(
      capped?.references?.filter(
        (reference) => reference.name === "targetSymbol",
      ),
    ).toEqual([
      expect.objectContaining({
        start_line: 2,
        end_line: 2,
      }),
    ]);

    const response = await searchSourceIndex(tmpRoot, "targetSymbol", {
      limit: 5,
      includeImpact: true,
      impactLimit: 2,
    });
    const result = response.results.find(
      (entry) => entry.file_path === "src/deduped-capped-references.ts",
    );

    const approximateReferences =
      result?.impact_context?.approximate_references ?? [];

    expect(approximateReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_path: "src/deduped-capped-references.ts",
          start_line: 2,
          end_line: 2,
          reason: "identifier reference mentions targetSymbol",
        }),
        expect.objectContaining({
          file_path: "src/deduped-capped-references.ts",
          start_line: lateTargetLine - 1,
          reason: "chunk text mentions targetSymbol",
        }),
      ]),
    );
  });

  test("impact fallback searches straddling chunk tails after exact references", async () => {
    const duplicateLines = Array.from(
      { length: 1100 },
      () => "  repeatedValue; repeatedValue;",
    );
    const sourceLines = [
      "export function allTargetUses() {",
      "  targetSymbol();",
      ...duplicateLines,
      "  targetSymbol();",
      "}",
      "",
      "export function targetSymbol() {",
      "  return 1;",
      "}",
    ];

    await write("src/straddling-capped-references.ts", sourceLines.join("\n"));

    const index = await scanSourceIndex(tmpRoot);
    const capped = index.files["src/straddling-capped-references.ts"];

    expect(capped?.references_truncated).toBe(true);
    expect(
      capped?.references?.filter(
        (reference) => reference.name === "targetSymbol",
      ),
    ).toEqual([
      expect.objectContaining({
        start_line: 2,
        end_line: 2,
      }),
    ]);

    const response = await searchSourceIndex(tmpRoot, "targetSymbol", {
      limit: 5,
      includeImpact: true,
      impactLimit: 2,
    });
    const result = response.results.find(
      (entry) => entry.file_path === "src/straddling-capped-references.ts",
    );

    const approximateReferences =
      result?.impact_context?.approximate_references ?? [];

    expect(approximateReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_path: "src/straddling-capped-references.ts",
          start_line: 2,
          end_line: 2,
          reason: "identifier reference mentions targetSymbol",
        }),
        expect.objectContaining({
          file_path: "src/straddling-capped-references.ts",
          start_line: 3,
          reason: "chunk text mentions targetSymbol",
        }),
      ]),
    );
  });

  test("impact references fall back to later chunks when exact references are capped", async () => {
    const fillerLines = Array.from(
      { length: 2100 },
      (_, index) => `  filler${index};`,
    );
    const sourceLines = [
      "export function firstTargetUse() {",
      "  targetSymbol();",
      ...fillerLines,
      "}",
      "",
      "export function lateTargetUse() {",
      "  targetSymbol();",
      "}",
      "",
      "export function targetSymbol() {",
      "  return 1;",
      "}",
    ];
    const lateTargetLine =
      sourceLines.findIndex(
        (line, index) => index > 10 && line === "  targetSymbol();",
      ) + 1;

    await write("src/capped-references.ts", sourceLines.join("\n"));

    const index = await scanSourceIndex(tmpRoot);
    const capped = index.files["src/capped-references.ts"];

    expect(capped?.references?.length).toBe(2000);
    expect(
      capped?.references?.filter(
        (reference) => reference.name === "targetSymbol",
      ),
    ).toEqual([
      expect.objectContaining({
        start_line: 2,
        end_line: 2,
      }),
    ]);

    const response = await searchSourceIndex(tmpRoot, "targetSymbol", {
      limit: 5,
      includeImpact: true,
      impactLimit: 2,
    });
    const result = response.results.find(
      (entry) => entry.file_path === "src/capped-references.ts",
    );

    const approximateReferences =
      result?.impact_context?.approximate_references ?? [];

    expect(approximateReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_path: "src/capped-references.ts",
          start_line: 2,
          end_line: 2,
          reason: "identifier reference mentions targetSymbol",
        }),
        expect.objectContaining({
          file_path: "src/capped-references.ts",
          start_line: lateTargetLine - 1,
          reason: "chunk text mentions targetSymbol",
        }),
      ]),
    );
    expect(approximateReferences).not.toContainEqual(
      expect.objectContaining({
        file_path: "src/capped-references.ts",
        start_line: 1,
        reason: "chunk text mentions targetSymbol",
      }),
    );
  });

  test("chunk fallback previews preserve stored CRLF line endings", async () => {
    await write(
      "src/crlf-target.ts",
      "export function crlfTarget() {\n  return 1;\n}",
    );
    await write(
      "src/crlf-legacy-consumer.ts",
      [
        "export function consumeCrlf() {",
        "  crlfTarget();",
        "  return crlfTarget;",
        "}",
      ].join("\n"),
    );

    const index = await scanSourceIndex(tmpRoot);
    const consumer = index.files["src/crlf-legacy-consumer.ts"];
    expect(consumer).toBeDefined();
    if (!consumer) return;

    delete consumer.references;
    delete consumer.references_truncated;
    for (const chunk of consumer.chunks) {
      chunk.content = chunk.content.replaceAll("\n", "\r\n");
    }
    delete index.search;
    await fs.writeFile(
      sourceIndexPath(tmpRoot),
      `${JSON.stringify(index, null, 2)}\n`,
    );

    const response = await searchSourceIndex(tmpRoot, "crlfTarget", {
      limit: 5,
      includeImpact: true,
      impactLimit: 5,
      impactContentChars: 200,
    });
    const result = response.results.find(
      (entry) => entry.file_path === "src/crlf-target.ts",
    );
    const fallbackReference =
      result?.impact_context?.approximate_references.find(
        (reference) =>
          reference.file_path === "src/crlf-legacy-consumer.ts" &&
          reference.reason === "chunk text mentions crlfTarget",
      );

    expect(fallbackReference?.content_preview).toBe(
      [
        "export function consumeCrlf() {",
        "  crlfTarget();",
        "  return crlfTarget;",
        "}",
      ].join("\r\n"),
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
    await write("src/readme.md", "Markdown docs are indexed for retrieval");
    await write("src/notes.txt", "not a supported source extension");
    await write("src/client.generated.ts", "export function generated() {}");
    await write("src/huge.ts", "x".repeat(257 * 1024));

    const index = await scanSourceIndex(tmpRoot);

    expect(index.files["src/readme.md"]?.language).toBe("markdown");
    expect(index.files["src/notes.txt"]).toBeUndefined();
    expect(index.files["src/client.generated.ts"]).toBeUndefined();
    expect(index.files["src/huge.ts"]).toBeUndefined();
    expect(index.stats.files_skipped).toBeGreaterThanOrEqual(3);
  });

  test("markdown files use fallback extraction even when content looks like TypeScript", async () => {
    await write(
      "docs/runbook.md",
      [
        "export function markdownAstProbe() {",
        "  return helperValue;",
        "}",
        "const helperValue = 1;",
      ].join("\n"),
    );

    const index = await scanSourceIndex(tmpRoot);
    const file = index.files["docs/runbook.md"];

    expect(file?.language).toBe("markdown");
    expect(file?.symbols.map((symbol) => symbol.name)).toEqual([
      "markdownAstProbe",
    ]);
    expect(file?.references).toEqual([]);
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
        "import {",
        "  requireActiveUser,",
        "} from './auth';",
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
          start_line: 1,
          end_line: 3,
          import_line: 1,
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
          start_line: 6,
          end_line: 6,
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
    expect(response.results[0]?.content).toContain("Handshake sentinel");

    const constantResponse = await searchSourceIndex(tmpRoot, "SCHEMA_VERSION", {
      limit: 1,
    });
    expect(constantResponse.results[0]?.file_path).toBe("src/preamble.ts");
    expect(constantResponse.results[0]?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "SCHEMA_VERSION", kind: "const" }),
      ]),
    );
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
    expect(response.warnings).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("before relying on source hits"),
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
