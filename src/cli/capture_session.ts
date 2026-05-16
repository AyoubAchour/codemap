import {
	type CaptureEventKind,
	isCaptureEventKind,
	summarizeCaptureSession,
} from "../capture_events.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface CaptureSessionFlags {
	session?: string;
	kind?: string[];
	limit?: number;
}

export async function captureSession(
	flags: CaptureSessionFlags,
	options: GlobalOptions,
): Promise<CommandResult> {
	try {
		const kinds = parseKinds(flags.kind);
		const summary = await summarizeCaptureSession(options.repoRoot, {
			sessionId: flags.session,
			kinds,
			limit: flags.limit,
		});

		return {
			exitCode: 0,
			stdout: `${JSON.stringify({ ok: true, ...summary }, null, 2)}\n`,
		};
	} catch (err) {
		return {
			exitCode: 1,
			stderr: `${JSON.stringify({
				ok: false,
				error: {
					code: "CAPTURE_SESSION_FAILED",
					message: err instanceof Error ? err.message : String(err),
				},
			})}\n`,
		};
	}
}

function parseKinds(
	kinds: string[] | undefined,
): CaptureEventKind[] | undefined {
	if (kinds === undefined) return undefined;
	return kinds.map((kind) => {
		if (!isCaptureEventKind(kind)) {
			throw new Error(`invalid capture event kind: ${kind}`);
		}
		return kind;
	});
}
