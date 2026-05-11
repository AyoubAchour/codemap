import { requireWorkspaceSession, type SessionActor } from "../auth/session";
import { createProjectTask, type ProjectTaskDraft } from "./rename";
import { sendTaskDigest } from "../notifications/email";

export function assignTaskToOwner(actor: SessionActor, draft: ProjectTaskDraft) {
  const session = requireWorkspaceSession(actor);
  const task = createProjectTask(draft);
  sendTaskDigest(session.id, [task.title]);
  return {
    ...task,
    assignedBy: session.id,
  };
}
