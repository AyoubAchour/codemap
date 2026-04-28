// =============================================================
// Active topic — module-scoped state
//
// One process = one current active topic. Set via the `set_active_topic`
// tool, read by `emit_node` (task-014) when auto-tagging emissions per
// V1_SPEC §7.5.
//
// Why module-scoped (not on the McpServer)? An MCP server in stdio mode
// is one process per client connection. Module-scoped state is the
// simplest correct model. When v2 ships HTTP/SSE transport with
// Mcp-Session-Id headers (TECH_SPEC §5), this becomes a Map<sessionId, …>.
// =============================================================

let activeTopic: string | null = null;

export function getActiveTopic(): string | null {
  return activeTopic;
}

export function setActiveTopic(name: string): void {
  activeTopic = name;
}

/**
 * Reset the in-memory state. Test-only — production code never needs this
 * because the process lifecycle handles it.
 *
 * @internal
 */
export function _resetActiveTopic(): void {
  activeTopic = null;
}
