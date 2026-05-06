import {
  inspectGraphHealth,
  type GraphHealthOkResponse,
} from "../graph_health.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface DoctorFlags {
  includeDeprecated?: boolean;
  issueLimit?: number;
  json?: boolean;
}

export async function doctor(
  flags: DoctorFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  const response = await inspectGraphHealth(options.repoRoot, {
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
      exitCode: response.summary.fresh ? 0 : 1,
      stdout: `${JSON.stringify(response, null, 2)}\n`,
    };
  }

  return {
    exitCode: response.summary.fresh ? 0 : 1,
    stdout: formatDoctorSummary(response),
  };
}

function formatDoctorSummary(response: GraphHealthOkResponse): string {
  const { summary, issues, suggestions } = response;
  const sourceBreakdown = [
    `${summary.anchor_changed_sources} anchor changed`,
    `${summary.changed_sources} legacy changed`,
    `${summary.missing_sources} missing`,
    `${summary.unsafe_sources} unsafe`,
    `${summary.read_errors} read errors`,
    `${summary.range_fresh_sources} range-fresh`,
  ].join(", ");
  const lines = [
    `Codemap graph health: ${summary.fresh ? "clean" : "issues found"}`,
    "",
    `Nodes: ${summary.active_nodes} active, ${summary.deprecated_nodes} deprecated, ${summary.total_edges} edges`,
    `Sources: ${summary.checked_sources} checked, ${summary.stale_sources} stale (${sourceBreakdown})`,
    `Validator: ${summary.duplicate_aliases} duplicate aliases, ${summary.validator_repairs} repairs, ${summary.validator_errors} errors`,
  ];

  if (summary.truncated_stale_sources) {
    lines.push(
      `Reported stale anchors: ${summary.reported_stale_sources} of ${summary.stale_sources} (use --json for the full staleness report)`,
    );
  }

  if (issues.stale_sources.length > 0) {
    lines.push("", "Stale source anchors:");
    for (const source of issues.stale_sources) {
      lines.push(`- ${source.reason}: ${source.node_id} -> ${source.file_path}`);
    }
  }

  if (issues.duplicate_aliases.length > 0) {
    lines.push("", "Duplicate aliases:");
    for (const issue of issues.duplicate_aliases) {
      lines.push(`- ${issue.alias}: ${issue.nodeIds.join(", ")}`);
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
