import type { Command } from "commander";
import { detectResumeState } from "@deepthonk/core";
import { resolveCliPath } from "../config.js";

export function registerResume(program: Command): void {
  program
    .command("resume")
    .description("Detect resumability for a run directory.")
    .argument("<runDir>")
    .action(async (runDir: string) => {
      runDir = resolveCliPath(runDir);
      const status = await detectResumeState(runDir);
      console.log(JSON.stringify(status, null, 2));
      if (status.status !== "completed" && status.safe_to_continue !== true) process.exitCode = 1;
    });
}
