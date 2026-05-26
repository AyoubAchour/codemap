import { buildCaptureSummaries } from "../capture_summaries.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface CaptureSummaryFlags {
	session?: string;
	limit?: number;
	exclude?: string[];
	write?: boolean;
}

export async function captureSummary(
	flags: CaptureSummaryFlags,
	options: GlobalOptions,
): Promise<CommandResult> {
	try {
		const summary = await buildCaptureSummaries(options.repoRoot, {
			sessionId: flags.session,
			limit: flags.limit,
			exclude: flags.exclude,
			write: flags.write ?? true,
		});

		return {
			exitCode: 0,
			stdout: `${JSON.stringify(summary, null, 2)}\n`,
		};
	} catch (err) {
		return {
			exitCode: 1,
			stderr: `${JSON.stringify({
				ok: false,
				error: {
					code: "CAPTURE_SUMMARY_FAILED",
					message: err instanceof Error ? err.message : String(err),
				},
			})}\n`,
		};
	}
}
