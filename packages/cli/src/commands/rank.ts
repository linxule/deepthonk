import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { rankCandidates, type CandidateInput } from "@deepthonk/core";
import { createDriver } from "@deepthonk/providers";
import { readPathOrInline, resolveCliPath, resolveProviderOnlyConfig } from "../config.js";

export function registerRank(program: Command): void {
  program
    .command("rank")
    .description("Rank user-provided JSONL candidates with pairwise judging.")
    .requiredOption("--task <path-or-inline>")
    .requiredOption("--candidates <jsonl>")
    .option("--rubric <path-or-inline>")
    .option("--config <yaml>")
    .option("--provider <provider>", "fake|deepseek|openrouter|openai-compatible or any OpenAI-compatible alias")
    .option("--base-url <url>")
    .option("--api-key-env <name>")
    .option("--judge-model <model>")
    .option("--judge-temperature <number>", "Temperature for pairwise judging")
    .option("--lambda <number>", "Bradley-Terry L2 regularization")
    .option("--concurrency <number>", "Maximum concurrent pairwise comparisons")
    .option("--prompt-style <style>", "general|paper-programming")
    .option("--prompts-json <json>", "Inline JSON object with a compare prompt override")
    .action(async (options) => {
      const task = await readPathOrInline(options.task);
      const rubric = options.rubric ? await readPathOrInline(options.rubric) : undefined;
      const candidates: CandidateInput[] = (await readFile(resolveCliPath(options.candidates), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line: string, index: number) => {
          const parsed = JSON.parse(line) as { id?: string; content: string };
          return { id: parsed.id ?? `candidate-${index + 1}`, content: parsed.content };
        });
      const resolved = await resolveProviderOnlyConfig(options);
	      const result = await rankCandidates({
	        task,
	        rubric,
	        candidates,
	        driver: createDriver(resolved.providerConfig),
	        judgeModel: resolved.models.judge,
	        temperature: numberOption(options.judgeTemperature),
	        lambda: numberOption(options.lambda),
	        concurrency: numberOption(options.concurrency),
	        promptStyle: options.promptStyle,
	        promptOverrides: parsePromptOverridesJson(options.promptsJson)
	      });
      console.log(JSON.stringify(result.scores, null, 2));
    });
}

function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return Number(value);
}

function parsePromptOverridesJson(value: unknown): { compare?: { system?: string; user?: string } } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return JSON.parse(String(value)) as { compare?: { system?: string; user?: string } };
}
