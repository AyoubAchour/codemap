import { GraphStore } from "../graph.js";
import { NodeStatusSchema } from "../schema.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface CorrectFlags {
  summary?: string;
  name?: string;
  confidence?: number;
  status?: string;
  addAlias?: string[];
  removeAlias?: string[];
  addTag?: string[];
  removeTag?: string[];
}

/**
 * `codemap correct <id> [...flags]` — manual override of scalar/list node fields.
 * Bypasses the `upsertNode` merge logic (CLI corrections are explicit user
 * intent, not agent emissions). `last_verified_at` is bumped to now.
 *
 * Sources / line_ranges / kind / id / created_at are NOT correctable in v1 —
 * they're complex shapes. An $EDITOR workflow is deferred to v2.
 *
 * Exit codes: 0 = ok, 1 = node not found / invalid flag value, 2 = schema-invalid.
 */
export async function correct(
  id: string,
  flags: CorrectFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  // Validate flag values up front so we don't half-apply on a bad input.
  if (flags.confidence !== undefined) {
    if (
      typeof flags.confidence !== "number" ||
      Number.isNaN(flags.confidence) ||
      flags.confidence < 0 ||
      flags.confidence > 1
    ) {
      return {
        exitCode: 1,
        stderr: `${JSON.stringify({
          ok: false,
          error: {
            code: "INVALID_FLAG",
            message: "confidence must be a number in [0, 1]",
          },
        })}\n`,
      };
    }
  }
  if (flags.status !== undefined) {
    const parsed = NodeStatusSchema.safeParse(flags.status);
    if (!parsed.success) {
      return {
        exitCode: 1,
        stderr: `${JSON.stringify({
          ok: false,
          error: {
            code: "INVALID_FLAG",
            message: "status must be 'active' or 'deprecated'",
          },
        })}\n`,
      };
    }
  }

  let store: GraphStore;
  try {
    store = await GraphStore.load(options.repoRoot);
  } catch (err) {
    return {
      exitCode: 2,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "SCHEMA_INVALID", message: String(err) },
      })}\n`,
    };
  }

  const node = store.getNode(id);
  if (!node) {
    return {
      exitCode: 1,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "NODE_NOT_FOUND", message: `node not found: ${id}` },
      })}\n`,
    };
  }

  // Build the patch
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];

  if (flags.summary !== undefined) {
    patch.summary = flags.summary;
    changes.push("summary");
  }
  if (flags.name !== undefined) {
    patch.name = flags.name;
    changes.push("name");
  }
  if (flags.confidence !== undefined) {
    patch.confidence = flags.confidence;
    changes.push("confidence");
  }
  if (flags.status !== undefined) {
    patch.status = flags.status;
    changes.push("status");
  }

  // Tag mutations
  if (
    (flags.addTag && flags.addTag.length > 0) ||
    (flags.removeTag && flags.removeTag.length > 0)
  ) {
    const tags = [...node.tags];
    for (const t of flags.addTag ?? []) {
      if (!tags.includes(t)) tags.push(t);
    }
    const removeSet = new Set(flags.removeTag ?? []);
    patch.tags = tags.filter((t) => !removeSet.has(t));
    changes.push("tags");
  }

  // Alias mutations
  if (
    (flags.addAlias && flags.addAlias.length > 0) ||
    (flags.removeAlias && flags.removeAlias.length > 0)
  ) {
    const aliases = [...node.aliases];
    for (const a of flags.addAlias ?? []) {
      if (!aliases.includes(a)) aliases.push(a);
    }
    const removeSet = new Set(flags.removeAlias ?? []);
    patch.aliases = aliases.filter((a) => !removeSet.has(a));
    changes.push("aliases");
  }

  if (changes.length === 0) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        ok: true,
        message: "no flags supplied — nothing changed",
      })}\n`,
    };
  }

  store.overrideNode(node.id, patch);
  await store.save();

  const updated = store.getNode(node.id);
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(
      {
        ok: true,
        id: node.id,
        changed: changes,
        node: updated,
      },
      null,
      2,
    )}\n`,
  };
}
