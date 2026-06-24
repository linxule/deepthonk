import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectResumeState, resumeDeepThonk, runConfigSchema } from "@deepthonk/core";
import { createDriver, resolveProviderConfig } from "@deepthonk/providers";
import { resolveCliPath } from "../config.js";
import { parseProviderReplay, providerConfigFromReplay } from "../providerReplay.js";

export function registerResume(program: Command): void {
  program
    .command("resume")
    .description("Detect resumability for a run directory.")
    .argument("<runDir>")
    .option("--continue", "Replay an interrupted run from the last completed phase boundary.")
    .option("--dry-run", "With --continue, print the replay plan without running model calls.")
    .option("--provider <provider>", "Override the runtime provider label used for the replay driver.")
    .action(async (runDir: string, options: { continue?: boolean; dryRun?: boolean; provider?: string }) => {
      runDir = resolveCliPath(runDir);
      if (options.continue) {
        const { driver, provider } = await resumeDriverFromRunConfig(runDir, options.provider);
        const result = await resumeDeepThonk(runDir, driver, { dryRun: Boolean(options.dryRun), provider });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const status = await detectResumeState(runDir);
      console.log(JSON.stringify(status, null, 2));
      if (status.status !== "completed" && status.safe_to_continue !== true) process.exitCode = 1;
    });
}

async function resumeDriverFromRunConfig(runDir: string, providerOverride?: string): Promise<{ driver: ReturnType<typeof createDriver>; provider: string }> {
  const raw = JSON.parse(await readFile(join(runDir, "config.json"), "utf8")) as unknown;
  const config = runConfigSchema.parse(raw);
  const replay = parseProviderReplay(isRecord(raw) ? raw.providerReplay : undefined);
  const provider = providerOverride ?? replay?.provider ?? config.provider;
  const providerConfig = replay
    ? providerConfigFromReplay({ ...replay, provider }, config.retry)
    : resolveProviderConfig({
        provider,
        models: {
          generator: config.generatorModel,
          mutator: config.mutatorModel,
          judge: config.judgeModel,
          finalizer: config.finalizerModel
        },
        retry: config.retry
      });
  return { driver: createDriver(providerConfig), provider };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
