export function sendTaskDigest(ownerId: string, titles: string[]): string {
  return `task digest for ${ownerId}: ${titles.join(", ")}`;
}

export function describeOverdueTaskEmail(count: number): string {
  return `${count} overdue tasks need owner attention`;
}
