import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { findCollisions } from "../collision.js";
import { GraphStore } from "../graph.js";
import { recordMetric } from "../metrics.js";
import {
  NodeIdSchema,
  NodeKindSchema,
  NodeStatusSchema,
  SourceRefSchema,
} from "../schema.js";
import type { Node } from "../types.js";
import {
  getActiveTopic,
  getEmissionsThisTurn,
  incrementEmissionsThisTurn,
  PER_TURN_CAP,
} from "./_active_topic.js";
import type { ToolOptions } from "./query_graph.js";

const MAX_FUTURE_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

type SourceValidationResult = { ok: true } | { ok: false; message: string };

async function validateRepoSources(
  repoRoot: string,
  sources: Node["sources"],
): Promise<SourceValidationResult> {
  if (sources.length === 0) {
    return {
      ok: false,
      message:
        "emit_node requires at least one source anchored to a real repo file.",
    };
  }

  const root = path.resolve(repoRoot);
  for (const source of sources) {
    const filePath = source.file_path;
    const segments = filePath.split(/[\\/]+/).filter(Boolean);
    if (
      filePath.trim() === "" ||
      path.isAbsolute(filePath) ||
      filePath.includes("\0") ||
      segments.includes("..")
    ) {
      return {
        ok: false,
        message: `source.file_path must be a safe repo-relative path, got: ${filePath}`,
      };
    }

    const absolutePath = path.resolve(root, filePath);
    const relativePath = path.relative(root, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return {
        ok: false,
        message: `source.file_path escapes the repo root, got: ${filePath}`,
      };
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      return {
        ok: false,
        message: `source.file_path must reference an existing repo file, got: ${filePath}`,
      };
    }

    if (!stat.isFile()) {
      return {
        ok: false,
        message: `source.file_path must reference a file, got: ${filePath}`,
      };
    }
  }

  return { ok: true };
}

export function registerEmitNode(
  server: McpServer,
  options: ToolOptions,
): void {
  server.registerTool(
    "emit_node",
    {
      title: "Emit node",
      description:
        "Capture a codebase-relevant finding from repo exploration as a node in the graph. **Call this only after reading project code/docs and only for durable repo-local knowledge** — never for general Q&A, web research, installs, or external documentation. Sources must be real repo-relative files. Capture 1-5 high-value findings (prioritize decision/invariant/gotcha). Server-side collision detection: similar existing nodes return as candidates instead of writing — re-call with merge_with: <id> (same concept) or force_new: { reason: '<short>' } (genuinely different). Per-turn cap of 5; reset by calling set_active_topic. Auto-tags with the active topic.",
      inputSchema: {
        id: NodeIdSchema.describe(
          "Stable slug, e.g. 'auth/middleware'. Must not contain '|'.",
        ),
        kind: NodeKindSchema.describe(
          "Node kind. Prefer decision/invariant/gotcha for non-obvious knowledge.",
        ),
        name: z.string().min(1),
        summary: z.string(),
        sources: z
          .array(SourceRefSchema)
          .describe(
            "Real repo-relative files (with line ranges) where this node is anchored. Required; external URLs, absolute paths, missing files, and non-codebase conversation sources are rejected.",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Domain slugs (e.g. 'auth', 'payments', 'mobile'), 1-5 per node. NOT kind names — kind is a separate field. NOT meta-categories like 'gotcha' or 'todo'. Tags become topics for cross-cutting search; reuse existing topic slugs whenever possible to keep the topic map tight.",
          ),
        aliases: z.array(z.string()).optional(),
        status: NodeStatusSchema.optional(),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe(
            "0.9+ directly inspected; 0.5-0.8 inferred; <0.5 do not emit.",
          ),
        // Plain string at the schema level (no `format: "date-time"`, no
        // pattern). Reason: Zod's z.iso.datetime() emits a ~350-char
        // leap-year regex pattern that OpenAI's function-call schema subset
        // rejects, dropping the whole emit_node tool from the agent's view.
        // Switched in v0.1.2 (task-019). Validation moved into the handler
        // below — INVALID_TIMESTAMP error if Date.parse can't read it.
        // Storage NodeSchema (src/schema.ts) stays z.iso.datetime() so the
        // graph file remains strictly validated at load time.
        // No .min() / no schema-level format — all validation lives in the
        // handler's ISO_8601_UTC regex check below. Mixing schema-level and
        // handler-level checks splits the rejection paths (Zod error vs
        // INVALID_TIMESTAMP) and complicates downstream handling.
        last_verified_at: z
          .string()
          .describe(
            "Current ISO 8601 UTC timestamp at the moment of emission (e.g. 2026-05-01T12:00:00Z). Use the actual current moment, not a round-number or future value. Validated at runtime.",
          ),
        merge_with: z
          .string()
          .optional()
          .describe(
            "Existing node id to merge into. Skips collision detection. Mutually exclusive with force_new.",
          ),
        force_new: z
          .object({ reason: z.string().min(1) })
          .optional()
          .describe(
            "Force creation despite collision candidates. Reason is prepended to summary for audit. Mutually exclusive with merge_with.",
          ),
      },
    },
    async (args) => {
      // ---------- 1. Per-turn cap ----------
      if (getEmissionsThisTurn() >= PER_TURN_CAP) {
        await recordMetric(options.repoRoot, (m) => m.recordCap());
        const result = {
          ok: false,
          capped: true,
          message: `Per-turn emission cap (${PER_TURN_CAP}) reached. Reset by calling set_active_topic.`,
        };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: record(result),
        };
      }

      // ---------- 2. Mutual-exclusion validation ----------
      if (args.merge_with !== undefined && args.force_new !== undefined) {
        const result = {
          ok: false,
          error: {
            code: "INVALID_FLAGS",
            message:
              "merge_with and force_new are mutually exclusive — pass only one.",
          },
        };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: record(result),
        };
      }

      // ---------- 2b. Runtime timestamp validation ----------
      // The schema accepts any string (see comment on last_verified_at above —
      // a strict z.iso.datetime() emits a regex pattern that OpenAI-class
      // clients reject, dropping the whole tool). We re-impose the strict
      // check here so storage NodeSchema's z.iso.datetime() never fails at
      // load time on a value we accepted at write time.
      //
      // Two-layer check, equivalent to z.iso.datetime() (Zulu-only, default):
      //   1. ISO_8601_UTC regex pins the SHAPE — rejects date-only
      //      ("2026-05-01"), locale-style ("May 1 2026 12:00:00 GMT"),
      //      and offset-suffixed ("+05:00") strings that Date.parse alone
      //      would have accepted, then failed on next GraphStore.load.
      //      Greptile P1 / PR #16 review caught the original Date.parse-only
      //      version as a graph-corruption gap.
      //   2. Number.isNaN(Date.parse(...)) catches calendar-impossible
      //      dates that pass the regex's loose \d{2} ranges (e.g.
      //      "2026-13-45T12:00:00Z").
      //   3. A small future-skew guard catches fabricated round-number
      //      timestamps while tolerating ordinary clock drift.
      const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
      const parsedTimestamp = Date.parse(args.last_verified_at);
      if (
        !ISO_8601_UTC.test(args.last_verified_at) ||
        Number.isNaN(parsedTimestamp)
      ) {
        const result = {
          ok: false,
          error: {
            code: "INVALID_TIMESTAMP",
            message: `last_verified_at must be ISO 8601 UTC (e.g. 2026-05-01T12:00:00Z), got: ${args.last_verified_at}`,
          },
        };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: record(result),
        };
      }
      if (parsedTimestamp - Date.now() > MAX_FUTURE_TIMESTAMP_SKEW_MS) {
        const result = {
          ok: false,
          error: {
            code: "INVALID_TIMESTAMP",
            message:
              "last_verified_at appears to be in the future — use the current UTC time at emission.",
          },
        };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: record(result),
        };
      }

      // ---------- 3. Build the incoming Node ----------
      const incoming: Node = {
        id: args.id,
        kind: args.kind,
        name: args.name,
        summary: args.summary,
        sources: args.sources,
        tags: args.tags ?? [],
        aliases: args.aliases ?? [],
        status: args.status ?? "active",
        confidence: args.confidence,
        last_verified_at: args.last_verified_at,
      };
      const activeTopic = getActiveTopic() ?? undefined;

      // ---------- 3b. Source anchoring ----------
      // Codemap is codebase memory, not general conversation memory. The schema
      // validates shape; this runtime guard validates that every source points
      // at an actual file inside the current repo before any graph write.
      const sourceValidation = await validateRepoSources(
        options.repoRoot,
        incoming.sources,
      );
      if (!sourceValidation.ok) {
        const result = {
          ok: false,
          error: {
            code: "INVALID_SOURCE",
            message: sourceValidation.message,
          },
        };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: record(result),
        };
      }

      const store = await GraphStore.load(options.repoRoot);

      // ---------- 4. merge_with path ----------
      if (args.merge_with !== undefined) {
        const target = store.getNode(args.merge_with);
        if (!target) {
          const result = {
            ok: false,
            error: {
              code: "NODE_NOT_FOUND",
              message: `merge_with target not found: ${args.merge_with}`,
            },
          };
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: record(result),
          };
        }
        const upsertResult = store.upsertNode(incoming, {
          activeTopic,
          mergeWith: target.id,
        });
        await store.save();
        incrementEmissionsThisTurn();
        await recordMetric(options.repoRoot, (m) => m.recordEmit());
        const result = {
          ok: true,
          merged: upsertResult.merged,
          createdId: upsertResult.createdId,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: record(result),
        };
      }

      // ---------- 5. Default path: collision check ----------
      const candidates = findCollisions(incoming, store._data().nodes);

      if (candidates.length > 0 && args.force_new === undefined) {
        await recordMetric(options.repoRoot, (m) => m.recordCollision());
        // Plain success-with-flag (D1) — NOT isError. The agent must re-call
        // with merge_with or force_new to proceed.
        const result = {
          ok: false,
          collision: true,
          candidates: candidates.map((c) => {
            const node = store.getNode(c.id);
            return {
              id: c.id,
              name: node?.name ?? c.id,
              kind: node?.kind,
              summary: node?.summary.slice(0, 200),
              similarity: c.similarity,
            };
          }),
          next_action:
            "re-call emit_node with merge_with: <id> OR force_new: { reason: <string> }",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: record(result),
        };
      }

      // ---------- 6. force_new: prefix the reason into summary (D2) ----------
      if (args.force_new !== undefined) {
        incoming.summary = `[force_new: ${args.force_new.reason}] ${incoming.summary}`;
      }

      // ---------- 7. Write ----------
      const upsertResult = store.upsertNode(incoming, { activeTopic });
      await store.save();
      incrementEmissionsThisTurn();
      await recordMetric(options.repoRoot, (m) => m.recordEmit());
      const result = {
        ok: true,
        merged: upsertResult.merged,
        createdId: upsertResult.createdId,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: record(result),
      };
    },
  );
}
