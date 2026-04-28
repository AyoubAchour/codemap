import type { z } from "zod";
import type {
  EdgeKindSchema,
  EdgeSchema,
  GraphFileSchema,
  NodeKindSchema,
  NodeSchema,
  NodeStatusSchema,
  SourceRefSchema,
  TopicSchema,
} from "./schema.js";

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type NodeKind = z.infer<typeof NodeKindSchema>;
export type NodeStatus = z.infer<typeof NodeStatusSchema>;
export type Node = z.infer<typeof NodeSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Topic = z.infer<typeof TopicSchema>;
export type GraphFile = z.infer<typeof GraphFileSchema>;
