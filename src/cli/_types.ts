/**
 * Shared CLI plumbing types.
 *
 * Each CLI command function returns a CommandResult that the bin entry script
 * writes to the appropriate stream and uses for the process exit code. This
 * keeps the command functions pure (no direct stdout/stderr writes) so they're
 * unit-testable without spawning a subprocess.
 */

export interface CommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface GlobalOptions {
  repoRoot: string;
}
