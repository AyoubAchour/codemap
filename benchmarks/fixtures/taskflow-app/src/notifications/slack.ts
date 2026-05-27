export function sendSlackAssignmentNote(channel: string, title: string): string {
  return `assignment note for ${channel}: ${title}`;
}

export function describeSlackDigest(): string {
  return "slack digest notices are informational and do not assign task owners";
}
