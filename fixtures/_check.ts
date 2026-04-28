/**
 * Verifies each fixture matches its expected schema-parse outcome and (where
 * applicable) its expected validator outcome. Run as a quick sanity check after
 * editing fixtures.
 *
 * Run: `bun run fixtures/_check.ts`
 *
 * Exits non-zero if any fixture's actual behavior diverges from the expectation
 * declared in the EXPECTATIONS table below.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { GraphFileSchema } from "../src/schema.js";
import { applyRepairs, validate } from "../src/validator.js";

type Expectation = {
  schema: "ok" | "reject";
  /** Number of repair entries the validator should produce. Skipped if `schema: "reject"`. */
  repairs?: number;
  /** Number of warning entries the validator should produce. Skipped if `schema: "reject"`. */
  warnings?: number;
};

const EXPECTATIONS: Record<string, Expectation> = {
  "empty.json": { schema: "ok", repairs: 0, warnings: 0 },
  "small.json": { schema: "ok", repairs: 0, warnings: 0 },
  "with-aliases.json": { schema: "ok", repairs: 0, warnings: 0 },
  "with-collision-pairs.json": { schema: "ok", repairs: 0, warnings: 0 },
  "with-deprecated.json": { schema: "ok", repairs: 0, warnings: 0 },
  "knowledge-kinds.json": { schema: "ok", repairs: 0, warnings: 0 },
  "oversize.json": { schema: "ok", repairs: 0, warnings: 0 },
  // Validator-targeted fixtures
  "dangling-edges.json": { schema: "ok", repairs: 4, warnings: 0 }, // 3 edges; 1 has both endpoints missing → 2 reports
  "alias-collision.json": { schema: "ok", repairs: 0, warnings: 1 },
  "missing-topic.json": { schema: "ok", repairs: 2, warnings: 0 }, // tags: voice, ui
  "mixed.json": { schema: "ok", repairs: 3, warnings: 1 }, // 1 dangling + 2 missing-topic (tags 'duplication', 'ui'); 1 duplicate-alias ('papa')
  // Intentionally invalid
  "malformed-schema.json": { schema: "reject" },
};

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".json"))
  .sort();

let failures = 0;

for (const file of files) {
  const expected = EXPECTATIONS[file];
  if (!expected) {
    console.log(`✗ ${file} — no expectation declared in _check.ts`);
    failures++;
    continue;
  }

  const raw = JSON.parse(readFileSync(join(here, file), "utf8"));
  const parsed = GraphFileSchema.safeParse(raw);

  if (expected.schema === "reject") {
    if (parsed.success) {
      console.log(`✗ ${file} — expected schema-reject, got pass`);
      failures++;
    } else {
      console.log(`✓ ${file} — schema-reject (as expected)`);
    }
    continue;
  }

  if (!parsed.success) {
    console.log(
      `✗ ${file} — expected schema-ok, got reject: ${parsed.error.issues
        .slice(0, 2)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    failures++;
    continue;
  }

  const result = validate(parsed.data);
  const repairsCount = result.repairs.length;
  const warningsCount = result.warnings.length;

  const repairsExpected = expected.repairs ?? 0;
  const warningsExpected = expected.warnings ?? 0;
  const ok =
    repairsCount === repairsExpected && warningsCount === warningsExpected;

  if (ok) {
    // applyRepairs sanity check — should not throw
    applyRepairs(parsed.data, result);
    console.log(
      `✓ ${file} — repairs: ${repairsCount}, warnings: ${warningsCount}`,
    );
  } else {
    console.log(
      `✗ ${file} — expected repairs=${repairsExpected} warnings=${warningsExpected}, got repairs=${repairsCount} warnings=${warningsCount}`,
    );
    if (result.repairs.length > 0) {
      console.log(
        `    repairs: ${result.repairs.map((r) => r.kind).join(", ")}`,
      );
    }
    if (result.warnings.length > 0) {
      console.log(
        `    warnings: ${result.warnings.map((w) => w.kind).join(", ")}`,
      );
    }
    failures++;
  }
}

if (failures > 0) {
  console.log(`\n${failures} fixture(s) failed expectations.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} fixtures match expectations.`);
