/**
 * Subprocess helper: load a graph from <repoRoot>, upsert one node with the
 * given id, and save. Used by the atomic-save crash test and the concurrent-
 * save test in graph.test.ts.
 *
 * Usage:
 *   bun run test/unit/_helpers/save-runner.ts <repoRoot> <nodeId>
 *
 * Environment:
 *   CODEMAP_DEBUG_SLOW_SAVE=1   — forces a 1s pause between writeFile and rename
 *                                 (gated to NODE_ENV=test in graph.ts).
 */
import { GraphStore } from "../../../src/graph.js";

const repoRoot = process.argv[2];
const nodeId = process.argv[3];

if (!repoRoot || !nodeId) {
  console.error(
    "Usage: bun run save-runner.ts <repoRoot> <nodeId>",
  );
  process.exit(2);
}

const store = await GraphStore.load(repoRoot);
store.upsertNode({
  id: nodeId,
  kind: "invariant",
  name: nodeId,
  summary: `node emitted by save-runner for testing (${nodeId})`,
  sources: [
    {
      file_path: "test/runner.ts",
      line_range: [1, 10],
      content_hash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
  ],
  tags: [],
  aliases: [],
  status: "active",
  confidence: 0.9,
  last_verified_at: new Date().toISOString(),
});
await store.save();
console.log(`saved ${nodeId}`);
