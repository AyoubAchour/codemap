/**
 * Generates fixtures/oversize.json deterministically.
 *
 * Run: `bun run fixtures/_gen-oversize.ts`
 *
 * The output is reproducible: same inputs (topic list, kind list, counts,
 * coprime stride choices) → byte-identical JSON. Uses no randomness so
 * fixture diffs are caused only by schema or generator changes.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TS = "2026-04-28T00:00:00Z";
const TOPICS = [
  "auth",
  "payment",
  "billing",
  "messaging",
  "voice",
  "scheduling",
  "data",
  "search",
  "ui",
  "api",
];

// Cycled per node. ~25% knowledge-kind to keep the M3 ratio target plausible.
const KINDS = [
  "invariant",
  "gotcha",
  "decision",
  "concept",
  "integration",
  "flow",
  "file",
  "package",
];

const NODE_COUNT = 1000;
const EDGE_COUNT = 500;

const EDGE_KINDS = [
  "imports",
  "calls",
  "depends_on",
  "implements",
  "replaces",
  "contradicts",
  "derived_from",
  "mirrors",
] as const;

function buildId(i: number): string {
  const topic = TOPICS[i % TOPICS.length];
  return `${topic}/concept-${i}`;
}

function build() {
  const topics: Record<string, { created_at: string; auto_created: boolean }> =
    {};
  for (const t of TOPICS) {
    topics[t] = { created_at: TS, auto_created: true };
  }

  const nodes: Record<string, unknown> = {};
  for (let i = 0; i < NODE_COUNT; i++) {
    const id = buildId(i);
    const topic = TOPICS[i % TOPICS.length];
    const kind = KINDS[i % KINDS.length];
    nodes[id] = {
      kind,
      name: `${topic} concept ${i}`,
      summary: `Generated node #${i} in topic '${topic}'. Used to exercise oversize graph behavior in the test suite.`,
      sources: [
        {
          file_path: `src/${topic}/concept-${i}.ts`,
          line_range: [1, 1 + (i % 50)],
          content_hash:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      ],
      tags: [topic],
      aliases: [],
      status: "active",
      confidence: 0.9,
      last_verified_at: TS,
    };
  }

  const edges: Record<string, { note?: string }> = {};
  // Coprime strides → covers the index space without duplicates.
  for (let i = 0; i < EDGE_COUNT; i++) {
    const fromIdx = (i * 7 + 3) % NODE_COUNT;
    const toIdx = (i * 13 + 1) % NODE_COUNT;
    if (fromIdx === toIdx) continue;
    const fromId = buildId(fromIdx);
    const toId = buildId(toIdx);
    const kind = EDGE_KINDS[i % EDGE_KINDS.length];
    const key = `${fromId}|${toId}|${kind}`;
    if (edges[key]) continue;
    edges[key] = {};
  }

  return {
    version: 1,
    created_at: TS,
    topics,
    nodes,
    edges,
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "oversize.json");
const data = build();
writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${outPath} — ${Object.keys(data.nodes).length} nodes, ${Object.keys(data.edges).length} edges, ${Object.keys(data.topics).length} topics`,
);
