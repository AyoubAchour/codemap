import type { z } from "zod";
import type {
  EdgeKindSchema,
  EdgeSchema,
  GraphFileSchema,
  NodeKindSchema,
  NodeSchema,
  NodeStatusSchema,
  SourceRefSchema,
  StoredNodeSchema,
  TopicSchema,
} from "./schema.js";

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type NodeKind = z.infer<typeof NodeKindSchema>;
export type NodeStatus = z.infer<typeof NodeStatusSchema>;
export type Node = z.infer<typeof NodeSchema>;
/**
 * Storage shape for an entry in `GraphFile.nodes`: a `Node` with `id`
 * omitted (the id is the map key). Use this when you receive a raw value
 * from `loadedGraph.nodes[someId]` — typing it as `Node` would imply an
 * `id` field that isn't present.
 */
export type StoredNode = z.infer<typeof StoredNodeSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Topic = z.infer<typeof TopicSchema>;
export type GraphFile = z.infer<typeof GraphFileSchema>;
