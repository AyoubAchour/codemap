import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { SetupClient } from "./setup.js";

export type CaptureHookStatus =
	| "current"
	| "installed"
	| "updated"
	| "missing"
	| "stale"
	| "planned"
	| "manual"
	| "error";

export interface SetupCaptureHookResult {
	client: SetupClient;
	status: CaptureHookStatus;
	path?: string;
	script_path?: string;
	backup_path?: string;
	changed: boolean;
	message: string;
	manual_instructions?: string[];
}

export interface SetupCaptureHookOptions {
	homeDir: string;
	check?: boolean;
	force?: boolean;
	dryRun?: boolean;
	captureCommand?: string;
}

interface CodexHookSpec {
	event: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop";
	matcher?: string;
	statusMessage: string;
}

interface CodexHookCommand {
	command: string;
	commandWindows: string;
}


const CODEMAP_CAPTURE_HOOK_MARKER = "CODEMAP_HOOK_ID=codemap-capture";
const CODEMAP_CAPTURE_SCRIPT = "capture-hook.mjs";
const CODEX_HOOK_SPECS: CodexHookSpec[] = [
	{
		event: "SessionStart",
		matcher: "startup|resume|clear",
		statusMessage: "Capturing Codemap session evidence",
	},
	{
		event: "UserPromptSubmit",
		statusMessage: "Capturing Codemap prompt evidence",
	},
	{
		event: "PostToolUse",
		matcher: "^(mcp__codemap__.*|Bash|apply_patch|Edit|Write)$",
		statusMessage: "Capturing Codemap tool evidence",
	},
	{
		event: "Stop",
		statusMessage: "Capturing Codemap stop evidence",
	},
];

export async function setupCaptureHookClient(
	client: SetupClient,
	options: SetupCaptureHookOptions,
): Promise<SetupCaptureHookResult> {
	if (client === "codex") return setupCodexCaptureHooks(options);
	return unsupportedClientCaptureHooks(
		client,
		options.captureCommand ?? "codemap",
	);
}

async function setupCodexCaptureHooks(
	options: SetupCaptureHookOptions,
): Promise<SetupCaptureHookResult> {
	const hooksPath = path.join(options.homeDir, ".codex", "hooks.json");
	const scriptPath = path.join(
		options.homeDir,
		".codex",
		"codemap",
		CODEMAP_CAPTURE_SCRIPT,
	);
	const captureCommand = options.captureCommand ?? "codemap";
	const hookCommand = codexCaptureHookCommand(captureCommand, scriptPath);
	const expectedScript = codexCaptureHookScript();
	const existingHooks = await readJsonIfExists(hooksPath);
	if (!existingHooks.ok) {
		return errorResult("codex", hooksPath, existingHooks.error);
	}

	const existingScript = await readIfExists(scriptPath);
	const scriptFound = existingScript !== null;
	const scriptCurrent = existingScript === expectedScript;
	const hooksFound = existingHooks.found;
	const hooksCurrent =
		hooksFound && hasExpectedCodexHooks(existingHooks.value, hookCommand);
	const current = scriptCurrent && hooksCurrent;

	if (options.check) {
		return {
			client: "codex",
			status: current
				? "current"
				: hooksFound || scriptFound
					? "stale"
					: "missing",
			path: hooksPath,
			script_path: scriptPath,
			changed: false,
			message: current
				? "Codex capture hooks are configured."
				: "Codex capture hooks are missing or differ from the expected capture-event hooks.",
		};
	}

	if (current && !options.force) {
		return {
			client: "codex",
			status: "current",
			path: hooksPath,
			script_path: scriptPath,
			changed: false,
			message: "Codex capture hooks are already configured.",
		};
	}

	const nextHooks = mergeCodexHooks(existingHooks.value, hookCommand);
	const status = hooksFound || scriptFound ? "updated" : "installed";
	if (options.dryRun) {
		return {
			client: "codex",
			status: "planned",
			path: hooksPath,
			script_path: scriptPath,
			changed: false,
			message:
				status === "installed"
					? "Would install Codex capture hooks."
					: "Would update Codex capture hooks.",
		};
	}

	try {
		const backupPath =
			hooksFound && !hooksCurrent ? await backupFile(hooksPath) : undefined;
		await fs.mkdir(path.dirname(scriptPath), { recursive: true });
		await fs.writeFile(scriptPath, expectedScript, {
			encoding: "utf8",
			mode: 0o755,
		});
		await fs.chmod(scriptPath, 0o755);
		await fs.mkdir(path.dirname(hooksPath), { recursive: true });
		await fs.writeFile(
			hooksPath,
			`${JSON.stringify(nextHooks, null, 2)}\n`,
			"utf8",
		);
		return {
			client: "codex",
			status,
			path: hooksPath,
			script_path: scriptPath,
			backup_path: backupPath,
			changed: true,
			message:
				status === "installed"
					? "Installed Codex capture hooks."
					: "Updated Codex capture hooks.",
		};
	} catch (err) {
		return errorResult("codex", hooksPath, err);
	}
}

function unsupportedClientCaptureHooks(
	client: SetupClient,
	captureCommand: string,
): SetupCaptureHookResult {
	return {
		client,
		status: "manual",
		changed: false,
		message:
			"Capture hook setup is not automated for this client yet; use the manual capture-event commands below.",
		manual_instructions: [
			`Prompt hook: ${captureCommand} capture-event prompt --session <session-id> --agent ${client} --command <hook-name> --text <prompt>`,
			`Session start hook: ${captureCommand} capture-event session_start --session <session-id> --agent ${client} --command <hook-name> --data '{"hook_event_name":"SessionStart"}'`,
			"Hooks must append capture evidence only; do not call emit_node or link from lifecycle hooks.",
		],
	};
}

function codexCaptureHookCommand(
	captureCommand: string,
	scriptPath: string,
): CodexHookCommand {
	return {
		command: `${CODEMAP_CAPTURE_HOOK_MARKER} CODEMAP_CAPTURE_COMMAND=${shellQuote(
			captureCommand,
		)} node ${shellQuote(scriptPath)}`,
		commandWindows: `node ${windowsCommandQuote(scriptPath)} ${windowsCommandQuote(
			captureCommand,
		)}`,
	};
}

function mergeCodexHooks(
	value: unknown,
	command: CodexHookCommand,
): Record<string, unknown> {
	const root = isRecord(value) ? { ...value } : {};
	const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
	for (const spec of CODEX_HOOK_SPECS) {
		const existing = Array.isArray(hooks[spec.event])
			? [...(hooks[spec.event] as unknown[])]
			: [];
		hooks[spec.event] = [
			...existing.filter((entry) => !isCodemapCaptureHookGroup(entry)),
			codexHookGroup(spec, command),
		];
	}
	root.hooks = hooks;
	return root;
}

function hasExpectedCodexHooks(value: unknown, command: CodexHookCommand): boolean {
	if (!isRecord(value) || !isRecord(value.hooks)) return false;
	const hooks = value.hooks as Record<string, unknown>;
	return CODEX_HOOK_SPECS.every((spec) => {
		const groups = hooks[spec.event];
		return (
			Array.isArray(groups) &&
			groups.some((group) => hookGroupMatches(group, spec, command))
		);
	});
}

function codexHookGroup(
	spec: CodexHookSpec,
	command: CodexHookCommand,
): Record<string, unknown> {
	const group: Record<string, unknown> = {
		hooks: [
			{
				type: "command",
				command: command.command,
				commandWindows: command.commandWindows,
				timeout: 10,
				statusMessage: spec.statusMessage,
			},
		],
	};
	if (spec.matcher !== undefined) group.matcher = spec.matcher;
	return group;
}

function hookGroupMatches(
	value: unknown,
	spec: CodexHookSpec,
	command: CodexHookCommand,
): boolean {
	if (!isRecord(value)) return false;
	if ((value.matcher ?? undefined) !== (spec.matcher ?? undefined))
		return false;
	const hooks = value.hooks;
	return (
		Array.isArray(hooks) &&
		hooks.some(
			(hook) =>
				isRecord(hook) &&
				hook.type === "command" &&
				hook.command === command.command &&
				hook.commandWindows === command.commandWindows &&
				hook.statusMessage === spec.statusMessage,
		)
	);
}

function isCodemapCaptureHookGroup(value: unknown): boolean {
	if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
	return value.hooks.some(
		(hook) =>
			isRecord(hook) &&
			typeof hook.command === "string" &&
			hook.command.includes(CODEMAP_CAPTURE_HOOK_MARKER),
	);
}

async function backupFile(filePath: string): Promise<string> {
	const backupPath = `${filePath}.codemap-backup`;
	await fs.copyFile(filePath, backupPath);
	return backupPath;
}

async function readIfExists(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (err) {
		if (
			err instanceof Error &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return null;
		}
		throw err;
	}
}

async function readJsonIfExists(
	filePath: string,
): Promise<
	{ ok: true; found: boolean; value: unknown } | { ok: false; error: unknown }
> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		return { ok: true, found: true, value: JSON.parse(raw) };
	} catch (err) {
		if (
			err instanceof Error &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return { ok: true, found: false, value: {} };
		}
		return { ok: false, error: err };
	}
}

function codexCaptureHookScript(): string {
	return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_CAPTURE_TEXT = 8000;

try {
  const raw = readFileSync(0, "utf8");
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const mapped = mapHookPayload(payload);
  if (mapped) capture(mapped, payload);
} catch {
  // Capture hooks must never interrupt the agentic loop.
}

function capture(mapped, payload) {
  const captureCommand = process.argv[2] || process.env.CODEMAP_CAPTURE_COMMAND || "codemap";
  const cwd = stringValue(payload.cwd) || process.cwd();
  const sessionId = stringValue(payload.session_id) || "codex";
  const hookName = stringValue(payload.hook_event_name) || "codex-hook";
  const args = [
    "--repo",
    cwd,
    "capture-event",
    mapped.kind,
    "--session",
    sessionId,
    "--agent",
    "codex",
    "--command",
    hookName,
    "--data",
    JSON.stringify(mapped.data),
  ];
  if (mapped.text) args.push("--text", mapped.text);
  spawnSync(captureCommand, args, {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function mapHookPayload(payload) {
  const eventName = stringValue(payload.hook_event_name);
  if (eventName === "SessionStart") {
    return {
      kind: "session_start",
      data: commonData(payload),
    };
  }
  if (eventName === "UserPromptSubmit") {
    return {
      kind: "prompt",
      text: truncate(stringValue(payload.prompt)),
      data: commonData(payload),
    };
  }
  if (eventName === "Stop") {
    return {
      kind: "session_end",
      text: truncate(stringValue(payload.last_assistant_message)),
      data: commonData(payload),
    };
  }
  if (eventName === "PostToolUse") {
    return mapToolPayload(payload);
  }
  return null;
}

function mapToolPayload(payload) {
  const toolName = stringValue(payload.tool_name);
  if (!toolName) return null;
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const command = stringValue(toolInput.command);
  const isCodemapMcp = toolName.startsWith("mcp__codemap__");
  const isCodemapShell = toolName === "Bash" && /(^|\\s)codemap(-mcp)?(\\s|$)/.test(command);
  const isFileModification = /^(apply_patch|Edit|Write)$/.test(toolName);
  if (!isCodemapMcp && !isCodemapShell && !isFileModification) return null;
  return {
    kind: isFileModification ? "file_modified" : "codemap_call",
    data: {
      ...commonData(payload),
      tool_name: toolName,
      tool_use_id: stringValue(payload.tool_use_id),
      tool_input: redactLargeFields(toolInput),
      tool_response: redactLargeFields(payload.tool_response),
    },
  };
}

function commonData(payload) {
  return {
    hook_event_name: stringValue(payload.hook_event_name),
    turn_id: stringValue(payload.turn_id),
    cwd: stringValue(payload.cwd),
    model: stringValue(payload.model),
    transcript_path: stringValue(payload.transcript_path),
    stop_hook_active: payload.stop_hook_active === true,
  };
}

function redactLargeFields(value) {
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(redactLargeFields);
  if (isRecord(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 40)) {
      out[key] = redactLargeFields(entry);
    }
    return out;
  }
  return value;
}

function truncate(value) {
  if (!value) return undefined;
  return value.length > MAX_CAPTURE_TEXT
    ? \`\${value.slice(0, MAX_CAPTURE_TEXT)}...[truncated]\`
    : value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function windowsCommandQuote(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

function errorResult(
	client: SetupClient,
	configPath: string,
	err: unknown,
): SetupCaptureHookResult {
	return {
		client,
		status: "error",
		path: configPath,
		changed: false,
		message: err instanceof Error ? err.message : String(err),
	};
}
