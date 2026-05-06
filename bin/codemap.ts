#!/usr/bin/env node
/**
 * `codemap` CLI entry. Subcommands: init, show, correct, deprecate,
 * validate, doctor, rollup, setup, scan, context, changes-context,
 * generate-skills, search-source, index-status, clear-index.
 *
 * Each subcommand's logic lives in src/cli/<name>.ts as a pure function
 * returning { exitCode, stdout?, stderr? }; this entry file is the thin
 * commander glue + I/O shim.
 */
import { Command, InvalidArgumentError } from "commander";

import packageJson from "../package.json" with { type: "json" };
import {
  changesContext,
  type ChangesContextFlags,
} from "../src/cli/changes_context.js";
import { clearIndex } from "../src/cli/clear_index.js";
import { context, type ContextFlags } from "../src/cli/context.js";
import { correct, type CorrectFlags } from "../src/cli/correct.js";
import { deprecate, type DeprecateFlags } from "../src/cli/deprecate.js";
import { doctor, type DoctorFlags } from "../src/cli/doctor.js";
import {
  generateSkills,
  type GenerateSkillsFlags,
} from "../src/cli/generate_skills.js";
import { indexStatus } from "../src/cli/index_status.js";
import { init, type InitFlags } from "../src/cli/init.js";
import { rollup } from "../src/cli/rollup.js";
import { scan, type ScanFlags } from "../src/cli/scan.js";
import {
  setup,
  type SetupFlags,
} from "../src/cli/setup.js";
import {
  searchSource,
  type SearchSourceFlags,
} from "../src/cli/search_source.js";
import { show } from "../src/cli/show.js";
import {
  suggestWriteback,
  type SuggestWritebackFlags,
} from "../src/cli/suggest_writeback.js";
import { validate } from "../src/cli/validate.js";
import type { CommandResult, GlobalOptions } from "../src/cli/_types.js";
import type { ChangesRefreshMode } from "../src/changes_context.js";
import type {
  QueryContextMode,
  SourceRefreshMode,
} from "../src/query_context.js";
import type { SetupClient } from "../src/setup.js";

class CommandCompleted extends Error {
  constructor(readonly exitCode: number) {
    super("COMMAND_COMPLETED");
  }
}

function emit(result: CommandResult): never {
  if (result.stdout !== undefined) process.stdout.write(result.stdout);
  if (result.stderr !== undefined) process.stderr.write(result.stderr);
  // Keep `emit()` non-returning without `process.exit()`, which can truncate
  // large piped stdout reports before the runtime flushes them.
  throw new CommandCompleted(result.exitCode);
}

function repeatable(value: string, prev: string[] | undefined): string[] {
  return prev === undefined ? [value] : [...prev, value];
}

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  return parsed;
}

function parseRefreshIndex(value: string): SourceRefreshMode {
  if (
    value !== "never" &&
    value !== "if_missing" &&
    value !== "if_stale"
  ) {
    throw new InvalidArgumentError(
      "expected one of never, if_missing, if_stale",
    );
  }
  return value;
}

function parseQueryContextMode(value: string): QueryContextMode {
  if (value !== "compact" && value !== "standard" && value !== "full") {
    throw new InvalidArgumentError("expected one of compact, standard, full");
  }
  return value;
}

function parseChangesRefreshIndex(value: string): ChangesRefreshMode {
  return parseRefreshIndex(value) as ChangesRefreshMode;
}

function parseSetupClient(value: string): SetupClient {
  if (
    value !== "claude" &&
    value !== "codex" &&
    value !== "cursor" &&
    value !== "opencode"
  ) {
    throw new InvalidArgumentError(
      "expected one of claude, codex, cursor, opencode",
    );
  }
  return value;
}

const program = new Command();

program
  .name("codemap")
  .description(
    "Manual inspector / corrector for the Codemap knowledge graph (.codemap/graph.json).",
  )
  .version(packageJson.version)
  .option(
    "--repo <path>",
    "Path to the repo root (defaults to the current working directory).",
    process.cwd(),
  );

program
  .command("init")
  .description(
    "Generate AGENTS.md (and optionally CLAUDE.md) with the codemap lifecycle policy. Run once per project.",
  )
  .option("-f, --force", "Overwrite existing files.")
  .option(
    "--check",
    "Check generated guidance freshness without writing files; cannot be combined with --force.",
  )
  .option("--claude", "Also write CLAUDE.md.")
  .option("--all", "Write all known agent-preamble files (AGENTS.md + CLAUDE.md).")
  .action(async (cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: InitFlags = {
      force: cmdOpts.force as boolean | undefined,
      check: cmdOpts.check as boolean | undefined,
      claude: cmdOpts.claude as boolean | undefined,
      all: cmdOpts.all as boolean | undefined,
    };
    emit(await init(flags, { repoRoot: opts.repo }));
  });

program
  .command("setup")
  .description(
    "Configure global MCP clients for Codemap and validate basic install health.",
  )
  .option(
    "--client <name>",
    "Client to configure: codex, opencode, cursor, or claude. Repeatable. Defaults to all supported clients.",
    (value, previous: SetupClient[] | undefined) =>
      previous === undefined
        ? [parseSetupClient(value)]
        : [...previous, parseSetupClient(value)],
  )
  .option(
    "--check",
    "Check global client configuration without writing files; cannot be combined with --force.",
  )
  .option("-f, --force", "Rewrite existing Codemap MCP entries.")
  .option(
    "--command <cmd>",
    "MCP server command to write into client config.",
    "codemap-mcp",
  )
  .action(async (cmdOpts: Record<string, unknown>) => {
    const flags: SetupFlags = {
      client: cmdOpts.client as SetupClient[] | undefined,
      check: cmdOpts.check as boolean | undefined,
      force: cmdOpts.force as boolean | undefined,
      command: cmdOpts.command as string | undefined,
    };
    emit(await setup(flags));
  });

program
  .command("show <id>")
  .description("Print a node + its incident edges. `id` may be a canonical id or alias.")
  .action(async (id: string) => {
    const opts = program.opts() as { repo: string };
    emit(await show(id, { repoRoot: opts.repo } satisfies GlobalOptions));
  });

program
  .command("correct <id>")
  .description(
    "Manual override of scalar/list node fields. Bypasses agent merge rules.",
  )
  .option("--summary <s>", "Replace the node summary.")
  .option("--name <n>", "Replace the node name.")
  .option("--confidence <num>", "Set confidence (0..1).", Number.parseFloat)
  .option("--status <s>", "Set status (active or deprecated).")
  .option("--add-alias <a>", "Add an alias (repeatable).", repeatable)
  .option("--remove-alias <a>", "Remove an alias (repeatable).", repeatable)
  .option("--add-tag <t>", "Add a tag (repeatable).", repeatable)
  .option("--remove-tag <t>", "Remove a tag (repeatable).", repeatable)
  .action(async (id: string, cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: CorrectFlags = {
      summary: cmdOpts.summary as string | undefined,
      name: cmdOpts.name as string | undefined,
      confidence: cmdOpts.confidence as number | undefined,
      status: cmdOpts.status as string | undefined,
      addAlias: cmdOpts.addAlias as string[] | undefined,
      removeAlias: cmdOpts.removeAlias as string[] | undefined,
      addTag: cmdOpts.addTag as string[] | undefined,
      removeTag: cmdOpts.removeTag as string[] | undefined,
    };
    emit(await correct(id, flags, { repoRoot: opts.repo }));
  });

program
  .command("deprecate <id>")
  .description("Mark a node as deprecated. Optionally prepend a reason to its summary.")
  .option("--reason <r>", "Short reason; prepended as '[deprecated: <reason>] '.")
  .action(async (id: string, cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: DeprecateFlags = { reason: cmdOpts.reason as string | undefined };
    emit(await deprecate(id, flags, { repoRoot: opts.repo }));
  });

program
  .command("validate")
  .description(
    "Dry-run validator. Exit 0 if clean, 1 if warnings or repairs, 2 if schema-invalid.",
  )
  .action(async () => {
    const opts = program.opts() as { repo: string };
    emit(await validate({ repoRoot: opts.repo }));
  });

program
  .command("doctor")
  .description(
    "Inspect graph health: validation warnings/repairs plus source-anchor staleness.",
  )
  .option(
    "--include-deprecated",
    "Include deprecated nodes when checking source-anchor staleness.",
  )
  .option(
    "--issue-limit <n>",
    "Maximum stale source entries to show in compact output and JSON issue arrays.",
    parsePositiveInteger,
  )
  .option("--json", "Print the full structured health report.")
  .action(async (cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: DoctorFlags = {
      includeDeprecated: cmdOpts.includeDeprecated as boolean | undefined,
      issueLimit: cmdOpts.issueLimit as number | undefined,
      json: cmdOpts.json as boolean | undefined,
    };
    emit(await doctor(flags, { repoRoot: opts.repo }));
  });

program
  .command("rollup")
  .description("Compute the metrics weekly rollup for the current ISO week.")
  .action(async () => {
    const opts = program.opts() as { repo: string };
    emit(await rollup({ repoRoot: opts.repo }));
  });

program
  .command("scan")
  .description(
    "Build the rebuildable local source index used by search-source and MCP search_source.",
  )
  .option(
    "--max-file-bytes <n>",
    "Skip source files larger than this many bytes.",
    parsePositiveInteger,
  )
  .action(async (cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: ScanFlags = {
      maxFileBytes: cmdOpts.maxFileBytes as number | undefined,
    };
    emit(await scan(flags, { repoRoot: opts.repo }));
  });

program
  .command("search-source <query>")
  .description(
    "Search the local source index for relevant code chunks with match reasons. Run `codemap scan` first.",
  )
  .option("-l, --limit <n>", "Maximum results to return.", parsePositiveInteger)
  .option(
    "--max-content-chars <n>",
    "Maximum characters of chunk content per result.",
    parsePositiveInteger,
  )
  .option(
    "--dependency-limit <n>",
    "Maximum import/importer context entries per result.",
    parsePositiveInteger,
  )
  .option(
    "--include-impact",
    "Include bounded symbol/file impact context for each result.",
  )
  .option(
    "--impact-limit <n>",
    "Maximum impact entries per category.",
    parsePositiveInteger,
  )
  .action(async (query: string, cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: SearchSourceFlags = {
      limit: cmdOpts.limit as number | undefined,
      maxContentChars: cmdOpts.maxContentChars as number | undefined,
      dependencyLimit: cmdOpts.dependencyLimit as number | undefined,
      includeImpact: cmdOpts.includeImpact as boolean | undefined,
      impactLimit: cmdOpts.impactLimit as number | undefined,
    };
    emit(await searchSource(query, flags, { repoRoot: opts.repo }));
  });

program
  .command("context <question>")
  .description(
    "Return fused repo context: graph/source matches, match reasons, staleness, warnings, and next steps.",
  )
  .option(
    "--mode <mode>",
    "Response detail mode: compact, standard, or full.",
    parseQueryContextMode,
  )
  .option("--graph-limit <n>", "Maximum graph nodes to return.", parsePositiveInteger)
  .option("--source-limit <n>", "Maximum source chunks to return.", parsePositiveInteger)
  .option(
    "--max-content-chars <n>",
    "Maximum characters of chunk content per source result.",
    parsePositiveInteger,
  )
  .option(
    "--dependency-limit <n>",
    "Maximum import/importer context entries per source result.",
    parsePositiveInteger,
  )
  .option(
    "--include-impact",
    "Include bounded symbol/file impact context in source results.",
  )
  .option(
    "--impact-limit <n>",
    "Maximum impact entries per category.",
    parsePositiveInteger,
  )
  .option(
    "--refresh-index <mode>",
    "Source index refresh mode: never, if_missing, or if_stale.",
    parseRefreshIndex,
  )
  .action(async (question: string, cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: ContextFlags = {
      mode: cmdOpts.mode as QueryContextMode | undefined,
      graphLimit: cmdOpts.graphLimit as number | undefined,
      sourceLimit: cmdOpts.sourceLimit as number | undefined,
      maxContentChars: cmdOpts.maxContentChars as number | undefined,
      dependencyLimit: cmdOpts.dependencyLimit as number | undefined,
      refreshIndex: cmdOpts.refreshIndex as SourceRefreshMode | undefined,
      includeImpact: cmdOpts.includeImpact as boolean | undefined,
      impactLimit: cmdOpts.impactLimit as number | undefined,
    };
    emit(await context(question, flags, { repoRoot: opts.repo }));
  });

program
  .command("changes-context")
  .description(
    "Inspect git changes and return source-impact context, stale graph anchors, likely tests/docs, and writeback suggestions.",
  )
  .option(
    "--base-ref <ref>",
    "Compare this git base ref against HEAD instead of the working tree.",
  )
  .option(
    "--no-untracked",
    "Ignore untracked files when inspecting the working tree.",
  )
  .option(
    "--refresh-index <mode>",
    "Source index refresh mode: never, if_missing, or if_stale.",
    parseChangesRefreshIndex,
  )
  .option(
    "--file-limit <n>",
    "Maximum changed files to analyze in detail.",
    parsePositiveInteger,
  )
  .option(
    "--dependency-limit <n>",
    "Maximum import/importer context entries per changed file.",
    parsePositiveInteger,
  )
  .option(
    "--impact-limit <n>",
    "Maximum impact entries per category.",
    parsePositiveInteger,
  )
  .option(
    "--max-content-chars <n>",
    "Maximum preview characters per impact/dependency entry.",
    parsePositiveInteger,
  )
  .option("--no-writeback", "Do not include read-only writeback suggestions.")
  .action(async (cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: ChangesContextFlags = {
      baseRef: cmdOpts.baseRef as string | undefined,
      includeUntracked: cmdOpts.untracked as boolean | undefined,
      refreshIndex: cmdOpts.refreshIndex as ChangesRefreshMode | undefined,
      fileLimit: cmdOpts.fileLimit as number | undefined,
      dependencyLimit: cmdOpts.dependencyLimit as number | undefined,
      impactLimit: cmdOpts.impactLimit as number | undefined,
      maxContentChars: cmdOpts.maxContentChars as number | undefined,
      noWriteback: cmdOpts.writeback === false,
    };
    emit(await changesContext(flags, { repoRoot: opts.repo }));
  });

program
  .command("generate-skills")
  .description(
    "Generate compact repo-local Codemap guidance from the source index and curated graph. This never writes graph memory.",
  )
  .option(
    "--output <path>",
    "Repo-relative output path.",
    ".codemap/skills/codemap-repo/SKILL.md",
  )
  .option("--check", "Check whether generated guidance is current without writing.")
  .option("--stdout", "Print generated guidance instead of writing it.")
  .action(async (cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: GenerateSkillsFlags = {
      output: cmdOpts.output as string | undefined,
      check: cmdOpts.check as boolean | undefined,
      stdout: cmdOpts.stdout as boolean | undefined,
    };
    emit(await generateSkills(flags, { repoRoot: opts.repo }));
  });

program
  .command("suggest-writeback")
  .description(
    "Suggest end-of-task graph writeback opportunities without creating nodes or links.",
  )
  .option(
    "--inspected-file <path>",
    "Repo-relative file inspected during the task. Repeatable.",
    repeatable,
  )
  .option(
    "--modified-file <path>",
    "Repo-relative file modified during the task. Repeatable.",
    repeatable,
  )
  .option("--summary <text>", "Short summary of what changed or was learned.")
  .option("--no-git", "Do not inspect git changed/untracked files.")
  .option("--limit <n>", "Maximum suggestions to return.", parsePositiveInteger)
  .action(async (cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: SuggestWritebackFlags = {
      inspectedFile: cmdOpts.inspectedFile as string[] | undefined,
      modifiedFile: cmdOpts.modifiedFile as string[] | undefined,
      summary: cmdOpts.summary as string | undefined,
      git: cmdOpts.git as boolean | undefined,
      limit: cmdOpts.limit as number | undefined,
    };
    emit(await suggestWriteback(flags, { repoRoot: opts.repo }));
  });

program
  .command("index-status")
  .description("Report source-index freshness and indexed file/chunk counts.")
  .action(async () => {
    const opts = program.opts() as { repo: string };
    emit(await indexStatus({ repoRoot: opts.repo }));
  });

program
  .command("clear-index")
  .description("Delete the rebuildable local source index cache.")
  .action(async () => {
    const opts = program.opts() as { repo: string };
    emit(await clearIndex({ repoRoot: opts.repo }));
  });

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  if (err instanceof CommandCompleted) {
    process.exitCode = err.exitCode;
  } else {
    throw err;
  }
}
