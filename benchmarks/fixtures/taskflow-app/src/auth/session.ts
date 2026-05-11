export interface SessionActor {
  id: string;
  role: "owner" | "member";
}

export function requireWorkspaceSession(actor: SessionActor | null): SessionActor {
  if (!actor) {
    throw new Error("workspace session required");
  }
  return actor;
}

export const SESSION_POLICY = "signed-in workspace actors may manage project tasks";
