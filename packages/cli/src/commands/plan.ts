import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { planBudget } from "@deepthonk/core";
import YAML from "yaml";
import { profileFromOptions, resolveCliPath } from "../config.js";

export function registerPlan(program: Command): void {
  program
    .command("plan")
    .description("Print DeepThonk call budget for a profile.")
    .option("--config <yaml>")
    .option("--profile <profile>", "quick|balanced|paper", "quick")
    .option("--n <number>")
    .option("--k <number>")
    .option("--t <number>")
    .option("--m <number>")
    .action(async (options) => {
      if (options.config) {
        const parsed = YAML.parse(await readFile(resolveCliPath(options.config), "utf8")) as { profile?: string };
        console.log(JSON.stringify(planBudget(parsed.profile === "balanced" || parsed.profile === "paper" ? parsed.profile : "quick"), null, 2));
        return;
      }
      const hasOverrides = Boolean(options.n || options.k || options.t || options.m);
      console.log(JSON.stringify(planBudget(hasOverrides ? profileFromOptions(options) : options.profile), null, 2));
    });
}
