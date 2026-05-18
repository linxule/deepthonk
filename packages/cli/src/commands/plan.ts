import type { Command } from "commander";
import { planBudget } from "@deepthonk/core";
import { profileFromOptions, resolvePlanProfile } from "../config.js";

export function registerPlan(program: Command): void {
  program
    .command("plan")
    .description("Print DeepThonk call budget for a profile.")
    .option("--config <yaml>")
    .option("--profile <profile>", "quick|balanced|paper")
    .option("--n <number>")
    .option("--k <number>")
    .option("--t <number>")
    .option("--m <number>")
    .action(async (options) => {
      if (options.config) {
        console.log(JSON.stringify(planBudget(await resolvePlanProfile(options)), null, 2));
        return;
      }
      const hasOverrides = Boolean(options.n || options.k || options.t || options.m);
      console.log(JSON.stringify(planBudget(hasOverrides ? profileFromOptions(options) : options.profile ?? "quick"), null, 2));
    });
}
