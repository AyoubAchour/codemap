import {
  inspectGraphRepair,
  type GraphRepairOkResponse,
} from "../graph_repair.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface RepairGraphFlags {
  includeDeprecated?: boolean;
  issueLimit?: number;
  json?: boolean;
}

export async function repairGraph(
  flags: RepairGraphFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  const response = await inspectGraphRepair(options.repoRoot, {
    includeDeprecated: flags.includeDeprecated,
    issueLimit: flags.issueLimit,
  });

  if (!response.ok) {
    return {
      exitCode: 2,
      stderr: `${JSON.stringify(response, null, 2)}\n`,
    };
  }

  if (flags.json) {
    return {
      exitCode: response.summary.clean ? 0 : 1,
      stdout: `${JSON.stringify(response, null, 2)}\n`,
    };
  }

  return {
    exitCode: response.summary.clean ? 0 : 1,
    stdout: formatRepairGraphSummary(response),
  };
}

function formatRepairGraphSummary(response: GraphRepairOkResponse): string {
  const { summary, proposals, suggestions } = response;
  const lines = [
    `Codemap graph repair: ${summary.clean ? "clean" : "proposals found"}`,
    "",
    `Sources: ${summary.checked_sources} checked, ${summary.proposals} repair proposals`,
    `Actions: ${summary.range_refreshes} range refreshes, ${summary.anchor_reviews} range reviews, ${summary.legacy_anchors} legacy anchors, ${summary.missing_sources} missing, ${summary.unsafe_sources} unsafe, ${summary.read_errors} read errors`,
  ];

  if (summary.truncated_proposals) {
    lines.push(
      `Reported proposals: ${summary.reported_proposals} of ${summary.proposals} (use --json for the full repair report)`,
    );
  }

  if (proposals.length > 0) {
    lines.push("", "Repair proposals:");
    for (const proposal of proposals) {
      lines.push(
        `- ${proposal.action}: ${proposal.node_id} -> ${proposal.file_path}:${proposal.line_range[0]}-${proposal.line_range[1]}`,
      );
    }
  }

  if (suggestions.length > 0) {
    lines.push("", "Suggestions:");
    for (const suggestion of suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
