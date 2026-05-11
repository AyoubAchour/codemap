export interface ProjectTaskDraft {
  title: string;
  ownerId: string;
}

function internalCreateTask(draft: ProjectTaskDraft) {
  return {
    id: `task:${draft.ownerId}:${draft.title.toLowerCase().replace(/\s+/g, "-")}`,
    title: draft.title,
    ownerId: draft.ownerId,
    status: "open" as const,
  };
}

export { internalCreateTask as createProjectTask };
