import * as path from "node:path";

export interface McpRepoRootInput {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export function resolveMcpRepoRoot(input: McpRepoRootInput = {}): string {
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const repoRoot =
    repoArgValue(argv) ??
    nonEmpty(env.CODEMAP_REPO_ROOT) ??
    nonEmpty(env.CLAUDE_PROJECT_DIR) ??
    cwd;

  return path.resolve(repoRoot);
}

function repoArgValue(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--repo requires a path");
      }
      return value;
    }
    if (arg?.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length);
      if (!value) throw new Error("--repo requires a path");
      return value;
    }
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}
