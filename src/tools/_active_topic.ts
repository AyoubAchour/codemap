// =============================================================
// Active topic + per-turn emission counter — module-scoped state
//
// One process = one active topic + one counter. Set via the
// `set_active_topic` tool. Both are read/mutated by `emit_node`
// (task-014) per V1_SPEC §7.5 and TECH_SPEC §5.
//
// Why module-scoped (not on the McpServer)? An MCP server in stdio mode
// is one process per client connection. Module-scoped state is the
// simplest correct model. When v2 ships HTTP/SSE transport with
// Mcp-Session-Id headers (TECH_SPEC §5), this becomes a Map<sessionId, …>.
// =============================================================

let activeTopic: string | null = null;
let emissionsThisTurn = 0;

/** Per-turn cap, per V1_SPEC §9.6 + TECH_SPEC §5. */
export const PER_TURN_CAP = 5;

export function getActiveTopic(): string | null {
  return activeTopic;
}

/**
 * Set the active topic. Resets the per-turn emission counter — every
 * `set_active_topic` call starts a fresh window per TECH_SPEC §5.
 */
export function setActiveTopic(name: string): void {
  activeTopic = name;
  emissionsThisTurn = 0;
}

export function getEmissionsThisTurn(): number {
  return emissionsThisTurn;
}

/** Returns the new count after the increment. */
export function incrementEmissionsThisTurn(): number {
  emissionsThisTurn += 1;
  return emissionsThisTurn;
}

/**
 * Reset all in-memory state. Test-only — production code never needs this
 * because the process lifecycle handles it.
 *
 * @internal
 */
export function _resetActiveTopic(): void {
  activeTopic = null;
  emissionsThisTurn = 0;
}
