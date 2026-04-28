import { z } from "zod";

// =============================================================
// Codemap graph schema (V1)
// Source of truth: V1_SPEC.md §6 + TECH_SPEC.md §3.1
// =============================================================

export const SourceRefSchema = z.object({
  file_path: z.string(),
  line_range: z.tuple([z.number(), z.number()]),
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

export const NodeSchema = z.object({
  id: z.string().min(1),
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
  from: z.string(),
  to: z.string(),
  kind: EdgeKindSchema,
  note: z.string().optional(),
});

export const TopicSchema = z.object({
  created_at: z.iso.datetime(),
  auto_created: z.boolean(),
});

export const GraphFileSchema = z.object({
  version: z.literal(1),
  created_at: z.iso.datetime(),
  topics: z.record(z.string(), TopicSchema),
  nodes: z.record(z.string(), NodeSchema.omit({ id: true })),
  edges: z.record(
    z.string(),
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
