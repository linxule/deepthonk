import type { Command } from "commander";
import { ConfigError, repairLegacyBudgetConfig } from "@deepthonk/core";
import { resolveCliPath } from "../config.js";

export function registerRepairBudget(program: Command): void {
  program
    .command("repair-budget")
    .description("Repair legacy [redacted] numeric budget fields using explicit original values.")
    .argument("<runDir>")
    .option("--set <path=value>", "Exact affected dotted path and positive integer; repeat for every affected field.", collect, [])
    .action(async (runDir: string, options: { set: string[] }) => {
      if (options.set.length === 0) {
        throw new ConfigError("repair-budget requires at least one --set <path=value> replacement.", {
          code: "resume.budget_repair_missing",
          retryable: false,
          fix: "Use the exact paths reported by deepthonk resume, for example --set budget.maxOutputTokens=4096."
        });
      }
      const replacements = Object.fromEntries(options.set.map(parseReplacement));
      const repaired = await repairLegacyBudgetConfig(resolveCliPath(runDir), replacements);
      console.log(JSON.stringify({ repaired }, null, 2));
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseReplacement(value: string): [string, number] {
  const separator = value.lastIndexOf("=");
  const path = separator > 0 ? value.slice(0, separator) : "";
  const raw = separator > 0 ? value.slice(separator + 1) : "";
  const allowed = /^budget\.(?:maxCalls|maxInputTokens|maxOutputTokens)$|^budget\.prices\.\d+\.longContextThresholdTokens$/;
  const numeric = Number(raw);
  if (!allowed.test(path) || !/^\d+$/.test(raw) || !Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new ConfigError(`Invalid budget repair replacement '${value}'.`, {
      code: "resume.budget_repair_invalid",
      retryable: false,
      fix: "Pass an exact reported budget path and positive integer, such as --set budget.maxInputTokens=100000."
    });
  }
  return [path, numeric];
}
