import { z } from "zod";

// =============================================================
// Codemap graph schema (V1)
// Source of truth: V1_SPEC.md §6 + TECH_SPEC.md §3.1
// =============================================================

export const SourceRefSchema = z.object({
  file_path: z.string(),
  // Uniform array (length 2) instead of z.tuple. Reason: Zod's tuple emits
  // JSON Schema with `items: [schemaA, schemaB]` (Draft-07 tuple syntax),
  // which OpenAI's function-call schema subset rejects — `items` must be a
  // single schema for them. Switched in v0.1.2 (task-019) so emit_node's
  // input schema is callable from Codex / OpenAI-class clients. Validation
  // is unchanged: still exactly 2 positive ints with start <= end.
  line_range: z
    .array(z.number().int().min(1))
    .length(2)
    .refine(
      ([start, end]) =>
        start !== undefined && end !== undefined && start <= end,
      {
        message: "line_range start must be <= end",
      },
    ),
  content_hash: z.string().regex(/^sha256:/),
});

export const NodeKindSchema = z.enum([
  "file",
  "symbol",
  "package",
  "integration",
  "concept",
  "flow",
  "decision",
  "invariant",
  "gotcha",
]);

export const NodeStatusSchema = z.enum(["active", "deprecated"]);

/**
 * Node id format: non-empty, no `|` (which is reserved as the edge-key
 * separator in `GraphFile.edges`). Slugs like `auth/middleware` are the
 * canonical form per V1_SPEC §6.1.
 */
export const NodeIdSchema = z
  .string()
  .min(1)
  .regex(/^[^|]+$/, "node id cannot contain '|'");

export const NodeSchema = z.object({
  id: NodeIdSchema,
  kind: NodeKindSchema,
  name: z.string().min(1),
  summary: z.string(),
  sources: z.array(SourceRefSchema),
  tags: z.array(z.string()),
  aliases: z.array(z.string()).default([]),
  status: NodeStatusSchema.default("active"),
  confidence: z.number().min(0).max(1),
  last_verified_at: z.iso.datetime(),
});

export const EdgeKindSchema = z.enum([
  "imports",
  "calls",
  "depends_on",
  "implements",
  "replaces",
  "contradicts",
  "derived_from",
  "mirrors",
]);

export const EdgeSchema = z.object({
  from: NodeIdSchema,
  to: NodeIdSchema,
  kind: EdgeKindSchema,
  note: z.string().optional(),
});

/**
 * Storage shape for the `nodes` map: a Node with `id` omitted (the id is
 * the map key in `GraphFile.nodes`). Exported so call sites that read raw
 * values from a loaded GraphFile can type them precisely.
 */
export const StoredNodeSchema = NodeSchema.omit({ id: true });

/**
 * Validates the structure of an edge key: `<from>|<to>|<kind>` with non-empty
 * from/to (no `|` per NodeIdSchema) and a `kind` in EdgeKindSchema.
 */
const VALID_EDGE_KINDS = new Set<string>(EdgeKindSchema.options);

export interface ParsedEdgeKey {
  from: string;
  to: string;
  kind: z.infer<typeof EdgeKindSchema>;
}

/**
 * Parse the canonical `<from>|<to>|<kind>` edge-key string.
 * Uses right-to-left splitting so the edge-kind suffix is authoritative.
 */
export function parseEdgeKey(key: string): ParsedEdgeKey | null {
  const lastBar = key.lastIndexOf("|");
  if (lastBar <= 0) return null;
  const secondLastBar = key.lastIndexOf("|", lastBar - 1);
  if (secondLastBar <= 0) return null;

  const from = key.slice(0, secondLastBar);
  const to = key.slice(secondLastBar + 1, lastBar);
  const kind = key.slice(lastBar + 1);
  if (
    !NodeIdSchema.safeParse(from).success ||
    !NodeIdSchema.safeParse(to).success ||
    !VALID_EDGE_KINDS.has(kind)
  ) {
    return null;
  }

  return { from, to, kind: kind as z.infer<typeof EdgeKindSchema> };
}

const EdgeKeySchema = z.string().refine((key) => parseEdgeKey(key) !== null, {
  message:
    "edge key must be 'from|to|<kind>' with non-empty from/to and kind in EdgeKindSchema",
});

export const TopicSchema = z.object({
  created_at: z.iso.datetime(),
  auto_created: z.boolean(),
});

export const GraphFileSchema = z.object({
  version: z.literal(1),
  created_at: z.iso.datetime(),
  topics: z.record(z.string(), TopicSchema),
  nodes: z.record(NodeIdSchema, StoredNodeSchema),
  edges: z.record(
    EdgeKeySchema,
    z.object({
      note: z.string().optional(),
    }),
  ),
});

// =============================================================
// Helpers
// =============================================================

/**
 * Build the canonical key for an edge entry in `edges{}`.
 * Edge identity per V1_SPEC §6.2 = the triple (from, to, kind).
 */
export function edgeKey(
  from: string,
  to: string,
  kind: z.infer<typeof EdgeKindSchema>,
): string {
  return `${from}|${to}|${kind}`;
}
