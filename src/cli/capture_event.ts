import {
	appendCaptureEvent,
	type CaptureAnchor,
	type CaptureEventKind,
	isCaptureEventKind,
} from "../capture_events.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface CaptureEventFlags {
	session?: string;
	anchor?: string[];
	text?: string;
	data?: string;
	agent?: string;
	command?: string;
	tool?: string;
	node?: string;
}

export async function captureEvent(
	kind: string,
	flags: CaptureEventFlags,
	options: GlobalOptions,
): Promise<CommandResult> {
	try {
		if (!isCaptureEventKind(kind)) {
			throw new Error(`invalid capture event kind: ${kind}`);
		}

		const payload = parsePayload(flags);
		const event = await appendCaptureEvent(options.repoRoot, {
			kind,
			session_id: flags.session,
			source: {
				agent: flags.agent,
				command: flags.command,
			},
			anchors: (flags.anchor ?? []).map(parseAnchor),
			payload,
		});

		return {
			exitCode: 0,
			stdout: `${JSON.stringify({ ok: true, event }, null, 2)}\n`,
		};
	} catch (err) {
		return {
			exitCode: 1,
			stderr: `${JSON.stringify({
				ok: false,
				error: {
					code: "CAPTURE_EVENT_FAILED",
					message: err instanceof Error ? err.message : String(err),
				},
			})}\n`,
		};
	}
}

function parsePayload(flags: CaptureEventFlags): Record<string, unknown> {
	const payload = flags.data === undefined ? {} : parseData(flags.data);
	if (flags.text !== undefined) payload.text = flags.text;
	if (flags.tool !== undefined) payload.tool = flags.tool;
	if (flags.node !== undefined) payload.node_id = flags.node;
	return payload;
}

function parseData(data: string): Record<string, unknown> {
	const parsed = JSON.parse(data) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("--data must be a JSON object");
	}
	return { ...(parsed as Record<string, unknown>) };
}

function parseAnchor(spec: string): CaptureAnchor {
	const parts = spec.split(":");
	if (parts.length < 3) {
		throw new Error("--anchor must use path:start:end");
	}
	const end = Number(parts.pop());
	const start = Number(parts.pop());
	const filePath = parts.join(":");
	return {
		file_path: filePath,
		line_range: [start, end],
	};
}

export type { CaptureEventKind };
