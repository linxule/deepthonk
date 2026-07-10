import type { Command } from "commander";
import { inspectRunLock, reclaimRunLock } from "@deepthonk/core";
import { resolveCliPath } from "../config.js";

export function registerLock(program: Command): void {
  const lock = program.command("lock").description("Inspect or explicitly reclaim a run-directory lock.");

  lock
    .command("inspect")
    .description("Inspect lock ownership, liveness, and the reclaim fingerprint.")
    .argument("<runDir>")
    .action(async (runDir: string) => {
      console.log(JSON.stringify(await inspectRunLock(resolveCliPath(runDir)), null, 2));
    });

  lock
    .command("reclaim")
    .description("Remove a lock only when its current content matches the inspected fingerprint.")
    .argument("<runDir>")
    .requiredOption("--fingerprint <sha256>")
    .action(async (runDir: string, options: { fingerprint: string }) => {
      const reclaimed = await reclaimRunLock(resolveCliPath(runDir), options.fingerprint);
      console.log(JSON.stringify({ reclaimed }, null, 2));
      if (!reclaimed) process.exitCode = 1;
    });
}
