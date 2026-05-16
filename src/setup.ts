import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  type SetupCaptureHookResult,
  setupCaptureHookClient,
} from "./capture_hook_setup.js";
import { checkGuidanceFiles, type GuidanceCheck } from "./guidance.js";

const execFileAsync = promisify(execFile);

export type SetupClient = "claude" | "codex" | "cursor" | "opencode";
export type SetupClientStatus =
  | "current"
  | "installed"
  | "updated"
  | "missing"
  | "planned"
  | "manual"
  | "error";

export interface SetupOptions {
  clients?: SetupClient[];
  check?: boolean;
  force?: boolean;
  dryRun?: boolean;
  captureHooks?: boolean;
  captureCommand?: string;
  command?: string;
  homeDir?: string;
  repoRoot?: string;
}

export interface SetupClientResult {
  client: SetupClient;
  status: SetupClientStatus;
  path?: string;
  changed: boolean;
  message: string;
  manual_command?: string;
}

export interface SetupResponse {
  ok: true;
  command: string;
  health: {
    node_version: string;
    node_ok: boolean;
    server_command_found: boolean;
    server_command_path?: string;
    guidance: SetupGuidanceHealth;
  };
  clients: SetupClientResult[];
  capture_hooks: SetupCaptureHookResult[];
  warnings: string[];
  next_steps: string[];
}

export type SetupGuidanceStatus =
  | "unchecked"
  | "current"
  | "missing"
  | "stale"
  | "error";

export interface SetupGuidanceHealth {
  checked: boolean;
  status: SetupGuidanceStatus;
  repo_root?: string;
  files: GuidanceCheck[];
  message: string;
}

const DEFAULT_CLIENTS: SetupClient[] = [
  "codex",
  "opencode",
  "cursor",
  "claude",
];

export async function setupCodemap(
  options: SetupOptions = {},
): Promise<SetupResponse> {
  const command = options.command ?? "codemap-mcp";
  const clients = options.clients?.length
    ? unique(options.clients)
    : DEFAULT_CLIENTS;
  const homeDir = options.homeDir ?? os.homedir();
  const health = await installHealth(command, options.repoRoot);
  const warnings: string[] = [];
  const results: SetupClientResult[] = [];
  const captureHooks: SetupCaptureHookResult[] = [];

  if (!health.server_command_found) {
    warnings.push(
      `Server command "${command}" was not found on PATH; install codemap-mcp globally or pass --command with an absolute command.`,
    );
  }
  if (!health.node_ok) {
    warnings.push(
      `Node.js ${process.version} is below Codemap's supported runtime (>=22).`,
    );
  }
  if (
    options.check &&
    health.guidance.checked &&
    health.guidance.status !== "current"
  ) {
    warnings.push(setupGuidanceWarning(health.guidance.status));
  }

  for (const client of clients) {
    results.push(await setupClient(client, { ...options, command, homeDir }));
  }

  if (options.captureHooks) {
    for (const client of clients) {
      captureHooks.push(
        await setupCaptureHookClient(client, {
          homeDir,
          check: options.check,
          force: options.force,
          dryRun: options.dryRun,
          captureCommand: options.captureCommand,
        }),
      );
    }
  }

  return {
    ok: true,
    command,
    health,
    clients: results,
    capture_hooks: captureHooks,
    warnings,
    next_steps: setupNextSteps(results, captureHooks, warnings, options.dryRun),
  };
}

function setupGuidanceWarning(status: SetupGuidanceStatus): string {
  if (status === "error") {
    return "Generated guidance could not be checked; inspect health.guidance.files for the read error.";
  }
  if (status === "missing") {
    return "Generated guidance is missing; run codemap init inside the repo.";
  }
  return "Generated guidance is stale; run codemap init --check inside the repo, then codemap init --force when ready to refresh.";
}

async function installHealth(
  command: string,
  repoRoot?: string,
): Promise<SetupResponse["health"]> {
  const found = await commandPath(command);
  return {
    node_version: process.version,
    node_ok: nodeMajorVersion(process.version) >= 22,
    server_command_found: found !== null,
    server_command_path: found ?? undefined,
    guidance: await guidanceHealth(repoRoot),
  };
}

async function guidanceHealth(repoRoot?: string): Promise<SetupGuidanceHealth> {
  if (!repoRoot) {
    return {
      checked: false,
      status: "unchecked",
      files: [],
      message:
        "No repo root supplied; run codemap setup from a repo or pass --repo.",
    };
  }

  const resolvedRoot = path.resolve(repoRoot);
  const files = await checkGuidanceFiles(resolvedRoot, ["AGENTS.md"]);
  const hasError = files.some((file) => file.status === "error");
  const allCurrent = files.every((file) => file.status === "current");
  const hasMissing = files.some((file) => file.status === "missing");
  const status: SetupGuidanceStatus = hasError
    ? "error"
    : allCurrent
      ? "current"
      : hasMissing
        ? "missing"
        : "stale";

  return {
    checked: true,
    status,
    repo_root: resolvedRoot,
    files,
    message:
      status === "current"
        ? "Generated repo guidance is current."
        : "Generated repo guidance is not current.",
  };
}

async function commandPath(command: string): Promise<string | null> {
  if (path.isAbsolute(command)) {
    try {
      await fs.access(command);
      return command;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("sh", [
      "-lc",
      `command -v ${shellQuote(command)}`,
    ]);
    const found = stdout.trim();
    return found || null;
  } catch {
    return null;
  }
}

function nodeMajorVersion(version: string): number {
  return Number(version.replace(/^v/, "").split(".")[0] ?? 0);
}

async function setupClient(
  client: SetupClient,
  options: Required<Pick<SetupOptions, "command" | "homeDir">> &
    Omit<SetupOptions, "command" | "homeDir">,
): Promise<SetupClientResult> {
  if (client === "codex") return setupCodexClient(options);
  if (client === "opencode") return setupOpenCodeClient(options);
  if (client === "cursor") return setupCursorClient(options);
  return setupClaudeClient(options);
}

async function setupCodexClient(
  options: Required<Pick<SetupOptions, "command" | "homeDir">> &
    Omit<SetupOptions, "command" | "homeDir">,
): Promise<SetupClientResult> {
  const configPath = path.join(options.homeDir, ".codex", "config.toml");
  const block = `[mcp_servers.codemap]\ncommand = "${escapeToml(options.command)}"\n`;
  return updateTomlBlock({
    client: "codex",
    configPath,
    blockHeader: "[mcp_servers.codemap]",
    block,
    check: options.check,
    force: options.force,
    dryRun: options.dryRun,
  });
}

async function setupOpenCodeClient(
  options: Required<Pick<SetupOptions, "command" | "homeDir">> &
    Omit<SetupOptions, "command" | "homeDir">,
): Promise<SetupClientResult> {
  const configPath = path.join(
    options.homeDir,
    ".config",
    "opencode",
    "config.json",
  );
  return updateJsonConfig({
    client: "opencode",
    configPath,
    check: options.check,
    force: options.force,
    dryRun: options.dryRun,
    updater: (value) => {
      const root = isRecord(value) ? { ...value } : {};
      const mcp = isRecord(root.mcp) ? { ...root.mcp } : {};
      mcp.codemap = { type: "local", command: [options.command] };
      root.mcp = mcp;
      return root;
    },
    isCurrent: (value) =>
      isRecord(value) &&
      isRecord(value.mcp) &&
      isRecord(value.mcp.codemap) &&
      value.mcp.codemap.type === "local" &&
      Array.isArray(value.mcp.codemap.command) &&
      value.mcp.codemap.command[0] === options.command,
  });
}

async function setupCursorClient(
  options: Required<Pick<SetupOptions, "command" | "homeDir">> &
    Omit<SetupOptions, "command" | "homeDir">,
): Promise<SetupClientResult> {
  const configPath = path.join(options.homeDir, ".cursor", "mcp.json");
  return updateJsonConfig({
    client: "cursor",
    configPath,
    check: options.check,
    force: options.force,
    dryRun: options.dryRun,
    updater: (value) => {
      const root = isRecord(value) ? { ...value } : {};
      const mcpServers = isRecord(root.mcpServers)
        ? { ...root.mcpServers }
        : {};
      mcpServers.codemap = { command: options.command };
      root.mcpServers = mcpServers;
      return root;
    },
    isCurrent: (value) =>
      isRecord(value) &&
      isRecord(value.mcpServers) &&
      isRecord(value.mcpServers.codemap) &&
      value.mcpServers.codemap.command === options.command,
  });
}

function setupClaudeClient(
  options: Required<Pick<SetupOptions, "command">>,
): SetupClientResult {
  return {
    client: "claude",
    status: "manual",
    changed: false,
    message:
      "Claude Code MCP configuration is managed by its CLI; run the manual command below.",
    manual_command: `claude mcp add codemap -- ${options.command}`,
  };
}

async function updateTomlBlock(input: {
  client: SetupClient;
  configPath: string;
  blockHeader: string;
  block: string;
  check?: boolean;
  force?: boolean;
  dryRun?: boolean;
}): Promise<SetupClientResult> {
  const existing = await readIfExists(input.configPath);
  const hasBlock = existing?.includes(input.blockHeader) ?? false;
  const current =
    existing !== null &&
    extractTomlBlock(existing, input.blockHeader) === input.block.trim();
  if (input.check) {
    return {
      client: input.client,
      status: current ? "current" : "missing",
      path: input.configPath,
      changed: false,
      message: current
        ? "Codemap MCP server is configured."
        : "Codemap MCP server is not configured or differs from the expected block.",
    };
  }
  if (current && !input.force) {
    return {
      client: input.client,
      status: "current",
      path: input.configPath,
      changed: false,
      message: "Codemap MCP server is already configured.",
    };
  }

  const next = hasBlock
    ? replaceTomlBlock(existing ?? "", input.blockHeader, input.block)
    : `${(existing ?? "").trimEnd()}${existing ? "\n\n" : ""}${input.block}`;
  if (input.dryRun) {
    return {
      client: input.client,
      status: "planned",
      path: input.configPath,
      changed: false,
      message: hasBlock
        ? "Would update Codemap MCP server configuration."
        : "Would install Codemap MCP server configuration.",
    };
  }
  try {
    await fs.mkdir(path.dirname(input.configPath), { recursive: true });
    await fs.writeFile(input.configPath, `${next.trimEnd()}\n`, "utf8");
    return {
      client: input.client,
      status: hasBlock ? "updated" : "installed",
      path: input.configPath,
      changed: true,
      message: hasBlock
        ? "Updated Codemap MCP server configuration."
        : "Installed Codemap MCP server configuration.",
    };
  } catch (err) {
    return errorResult(input.client, input.configPath, err);
  }
}

async function updateJsonConfig(input: {
  client: SetupClient;
  configPath: string;
  check?: boolean;
  force?: boolean;
  dryRun?: boolean;
  updater: (value: unknown) => Record<string, unknown>;
  isCurrent: (value: unknown) => boolean;
}): Promise<SetupClientResult> {
  const existing = await readJsonIfExists(input.configPath);
  if (!existing.ok) {
    return errorResult(input.client, input.configPath, existing.error);
  }
  const current = existing.found && input.isCurrent(existing.value);
  if (input.check) {
    return {
      client: input.client,
      status: current ? "current" : "missing",
      path: input.configPath,
      changed: false,
      message: current
        ? "Codemap MCP server is configured."
        : "Codemap MCP server is not configured or differs from the expected entry.",
    };
  }
  if (current && !input.force) {
    return {
      client: input.client,
      status: "current",
      path: input.configPath,
      changed: false,
      message: "Codemap MCP server is already configured.",
    };
  }
  if (input.dryRun) {
    return {
      client: input.client,
      status: "planned",
      path: input.configPath,
      changed: false,
      message: existing.found
        ? "Would update Codemap MCP server configuration."
        : "Would install Codemap MCP server configuration.",
    };
  }
  try {
    await fs.mkdir(path.dirname(input.configPath), { recursive: true });
    const next = input.updater(existing.value);
    await fs.writeFile(
      input.configPath,
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8",
    );
    return {
      client: input.client,
      status: existing.found ? "updated" : "installed",
      path: input.configPath,
      changed: true,
      message: existing.found
        ? "Updated Codemap MCP server configuration."
        : "Installed Codemap MCP server configuration.",
    };
  } catch (err) {
    return errorResult(input.client, input.configPath, err);
  }
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

function extractTomlBlock(content: string, header: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function replaceTomlBlock(
  content: string,
  header: string,
  block: string,
): string {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return `${content.trimEnd()}\n\n${block}`;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return [...lines.slice(0, start), block.trim(), ...lines.slice(end)].join(
    "\n",
  );
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResult(
  client: SetupClient,
  configPath: string,
  err: unknown,
): SetupClientResult {
  return {
    client,
    status: "error",
    path: configPath,
    changed: false,
    message: err instanceof Error ? err.message : String(err),
  };
}

function setupNextSteps(
  results: SetupClientResult[],
  captureHooks: SetupCaptureHookResult[],
  warnings: string[],
  dryRun?: boolean,
): string[] {
  const steps: string[] = [];
  if (warnings.length > 0) {
    steps.push(
      "Resolve install-health warnings before relying on global MCP setup.",
    );
  }
  for (const result of results) {
    if (result.manual_command) {
      steps.push(`Manual ${result.client} setup: ${result.manual_command}`);
    }
  }
  if (results.some((result) => result.changed)) {
    steps.push(
      "Restart or reload MCP clients so they pick up the new server configuration.",
    );
  }
  if (results.some((result) => result.status === "planned")) {
    steps.push(
      "Run codemap setup without --dry-run to write planned MCP client changes.",
    );
  }
  if (captureHooks.some((result) => result.status === "planned")) {
    steps.push(
      "Run codemap setup --capture-hooks without --dry-run to install capture hooks.",
    );
  }
  if (captureHooks.some((result) => result.changed)) {
    steps.push(
      "Restart Codex and review new hooks with /hooks before relying on capture.",
    );
  }
  if (
    !dryRun &&
    captureHooks.some(
      (result) => result.status === "missing" || result.status === "stale",
    )
  ) {
    steps.push(
      "Run codemap setup --capture-hooks to refresh missing or stale capture hooks.",
    );
  }
  for (const result of captureHooks) {
    for (const instruction of result.manual_instructions ?? []) {
      steps.push(`Manual ${result.client} capture hook setup: ${instruction}`);
    }
  }
  steps.push(
    "Run codemap init --check inside each repo to verify project guidance.",
  );
  return steps;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
