#!/usr/bin/env node
/**
 * `codemap` CLI entry. Subcommands: init, show, correct, deprecate,
 * validate, rollup, scan, search-source, index-status, clear-index.
 *
 * Each subcommand's logic lives in src/cli/<name>.ts as a pure function
 * returning { exitCode, stdout?, stderr? }; this entry file is the thin
 * commander glue + I/O shim.
 */
import { Command } from "commander";

import packageJson from "../package.json" with { type: "json" };
import { clearIndex } from "../src/cli/clear_index.js";
import { correct, type CorrectFlags } from "../src/cli/correct.js";
import { deprecate, type DeprecateFlags } from "../src/cli/deprecate.js";
import { indexStatus } from "../src/cli/index_status.js";
import { init, type InitFlags } from "../src/cli/init.js";
import { rollup } from "../src/cli/rollup.js";
import { scan, type ScanFlags } from "../src/cli/scan.js";
import {
  searchSource,
  type SearchSourceFlags,
} from "../src/cli/search_source.js";
import { show } from "../src/cli/show.js";
import { validate } from "../src/cli/validate.js";
import type { CommandResult, GlobalOptions } from "../src/cli/_types.js";

function emit(result: CommandResult): never {
  if (result.stdout !== undefined) process.stdout.write(result.stdout);
  if (result.stderr !== undefined) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

function repeatable(value: string, prev: string[] | undefined): string[] {
  return prev === undefined ? [value] : [...prev, value];
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
  .option("--claude", "Also write CLAUDE.md.")
  .option("--all", "Write all known agent-preamble files (AGENTS.md + CLAUDE.md).")
  .action(async (cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: InitFlags = {
      force: cmdOpts.force as boolean | undefined,
      claude: cmdOpts.claude as boolean | undefined,
      all: cmdOpts.all as boolean | undefined,
    };
    emit(await init(flags, { repoRoot: opts.repo }));
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
    Number.parseInt,
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
    "Search the local source index for relevant code chunks. Run `codemap scan` first.",
  )
  .option("-l, --limit <n>", "Maximum results to return.", Number.parseInt)
  .option(
    "--max-content-chars <n>",
    "Maximum characters of chunk content per result.",
    Number.parseInt,
  )
  .action(async (query: string, cmdOpts: Record<string, unknown>) => {
    const opts = program.opts() as { repo: string };
    const flags: SearchSourceFlags = {
      limit: cmdOpts.limit as number | undefined,
      maxContentChars: cmdOpts.maxContentChars as number | undefined,
    };
    emit(await searchSource(query, flags, { repoRoot: opts.repo }));
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

await program.parseAsync(process.argv);
