import { buildCaptureReport } from "../capture_report.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface CaptureReportFlags {
	session?: string;
	limit?: number;
	json?: boolean;
}

export async function captureReport(
	flags: CaptureReportFlags,
	options: GlobalOptions,
): Promise<CommandResult> {
	try {
		const report = await buildCaptureReport(options.repoRoot, {
			sessionId: flags.session,
			limit: flags.limit,
		});

		return {
			exitCode: 0,
			stdout: `${JSON.stringify(report, null, 2)}\n`,
		};
	} catch (err) {
		return {
			exitCode: 1,
			stderr: `${JSON.stringify({
				ok: false,
				error: {
					code: "CAPTURE_REPORT_FAILED",
					message: err instanceof Error ? err.message : String(err),
				},
			})}\n`,
		};
	}
}
