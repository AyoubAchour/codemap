import { generateRepoSkills } from "../repo_guidance.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface GenerateSkillsFlags {
  output?: string;
  check?: boolean;
  stdout?: boolean;
}

export async function generateSkills(
  flags: GenerateSkillsFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  try {
    const response = await generateRepoSkills(options.repoRoot, {
      outputPath: flags.output,
      check: flags.check,
      stdout: flags.stdout,
    });
    const { content, ...json } = response;
    if (flags.stdout && content) {
      return { exitCode: 0, stdout: content };
    }
    return {
      exitCode: flags.check && !response.current ? 1 : 0,
      stdout: `${JSON.stringify(json, null, 2)}\n`,
    };
  } catch (err) {
    return {
      exitCode: 1,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "GENERATE_SKILLS_FAILED", message: String(err) },
      })}\n`,
    };
  }
}
