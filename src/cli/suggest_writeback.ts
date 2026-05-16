import { buildWritebackSuggestions } from "../writeback_suggestions.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface SuggestWritebackFlags {
	inspectedFile?: string[];
	modifiedFile?: string[];
	summary?: string;
	git?: boolean;
	captureSession?: string;
	latestCaptureSession?: boolean;
	captureLimit?: number;
	limit?: number;
}

export async function suggestWriteback(
	flags: SuggestWritebackFlags,
	options: GlobalOptions,
): Promise<CommandResult> {
	const response = await buildWritebackSuggestions(options.repoRoot, {
		inspectedFiles: flags.inspectedFile,
		modifiedFiles: flags.modifiedFile,
		workSummary: flags.summary,
		includeGit: flags.git ?? true,
		captureSessionId: flags.captureSession,
		includeLatestCaptureSession: flags.latestCaptureSession,
		captureLimit: flags.captureLimit,
		limit: flags.limit,
	});

	return {
		exitCode: 0,
		stdout: `${JSON.stringify(response, null, 2)}\n`,
	};
}
