#!/usr/bin/env node
/**
 * `codemap` CLI entry. Subcommands: show, correct, deprecate, validate, rollup.
 *
 * Each subcommand's logic lives in src/cli/<name>.ts as a pure function
 * returning { exitCode, stdout?, stderr? }; this entry file is the thin
 * commander glue + I/O shim.
 */
import { Command } from "commander";

import { correct, type CorrectFlags } from "../src/cli/correct.js";
import { deprecate, type DeprecateFlags } from "../src/cli/deprecate.js";
import { rollup } from "../src/cli/rollup.js";
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
  .version("0.0.0")
  .option(
    "--repo <path>",
    "Path to the repo root (defaults to the current working directory).",
    process.cwd(),
  );

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

await program.parseAsync(process.argv);
