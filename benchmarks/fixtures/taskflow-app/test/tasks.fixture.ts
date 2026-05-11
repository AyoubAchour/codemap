import { assignTaskToOwner } from "../src/projects/tasks";

const actor = { id: "user-1", role: "owner" as const };

export function assignmentFixture() {
  return assignTaskToOwner(actor, {
    title: "Review sprint plan",
    ownerId: "user-2",
  });
}

if (assignmentFixture().assignedBy !== "user-1") {
  throw new Error("task assignment should preserve the assigning owner");
}
