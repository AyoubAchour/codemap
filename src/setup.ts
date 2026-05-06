import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SetupClient = "claude" | "codex" | "cursor" | "opencode";
export type SetupClientStatus =
  | "current"
  | "installed"
  | "updated"
  | "missing"
  | "manual"
  | "error";

export interface SetupOptions {
  clients?: SetupClient[];
  check?: boolean;
  force?: boolean;
  command?: string;
  homeDir?: string;
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
  };
  clients: SetupClientResult[];
  warnings: string[];
  next_steps: string[];
}

const DEFAULT_CLIENTS: SetupClient[] = ["codex", "opencode", "cursor", "claude"];

export async function setupCodemap(
  options: SetupOptions = {},
): Promise<SetupResponse> {
  const command = options.command ?? "codemap-mcp";
  const clients = options.clients?.length ? unique(options.clients) : DEFAULT_CLIENTS;
  const homeDir = options.homeDir ?? os.homedir();
  const health = await installHealth(command);
  const warnings: string[] = [];
  const results: SetupClientResult[] = [];

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

  for (const client of clients) {
    results.push(await setupClient(client, { ...options, command, homeDir }));
  }

  return {
    ok: true,
    command,
    health,
    clients: results,
    warnings,
    next_steps: setupNextSteps(results, warnings),
  };
}

async function installHealth(command: string): Promise<SetupResponse["health"]> {
  const found = await commandPath(command);
  return {
    node_version: process.version,
    node_ok: nodeMajorVersion(process.version) >= 22,
    server_command_found: found !== null,
    server_command_path: found ?? undefined,
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
    const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${shellQuote(command)}`]);
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
  });
}

async function setupOpenCodeClient(
  options: Required<Pick<SetupOptions, "command" | "homeDir">> &
    Omit<SetupOptions, "command" | "homeDir">,
): Promise<SetupClientResult> {
  const configPath = path.join(options.homeDir, ".config", "opencode", "config.json");
  return updateJsonConfig({
    client: "opencode",
    configPath,
    check: options.check,
    force: options.force,
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
    updater: (value) => {
      const root = isRecord(value) ? { ...value } : {};
      const mcpServers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {};
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
  options: Required<Pick<SetupOptions, "command" | "homeDir">>,
): SetupClientResult {
  void options.homeDir;
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
}): Promise<SetupClientResult> {
  const existing = await readIfExists(input.configPath);
  const hasBlock = existing?.includes(input.blockHeader) ?? false;
  const current = existing !== null && extractTomlBlock(existing, input.blockHeader) === input.block.trim();
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
  try {
    await fs.mkdir(path.dirname(input.configPath), { recursive: true });
    const next = input.updater(existing.value);
    await fs.writeFile(input.configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
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
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function readJsonIfExists(filePath: string): Promise<
  | { ok: true; found: boolean; value: unknown }
  | { ok: false; error: unknown }
> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { ok: true, found: true, value: JSON.parse(raw) };
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
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

function replaceTomlBlock(content: string, header: string, block: string): string {
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
  return [...lines.slice(0, start), block.trim(), ...lines.slice(end)].join("\n");
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
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
  warnings: string[],
): string[] {
  const steps: string[] = [];
  if (warnings.length > 0) {
    steps.push("Resolve install-health warnings before relying on global MCP setup.");
  }
  for (const result of results) {
    if (result.manual_command) {
      steps.push(`Manual ${result.client} setup: ${result.manual_command}`);
    }
  }
  if (results.some((result) => result.changed)) {
    steps.push("Restart or reload MCP clients so they pick up the new server configuration.");
  }
  steps.push("Run codemap init --check inside each repo to verify project guidance.");
  return steps;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
