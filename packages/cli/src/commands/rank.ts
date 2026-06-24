import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { rankCandidates, type CandidateInput } from "@deepthonk/core";
import { createDriver } from "@deepthonk/providers";
import { readPathOrInline, resolveCliPath, resolveOneShotConfig } from "../config.js";
import { numberOption } from "../options.js";

export function registerRank(program: Command): void {
  program
    .command("rank")
    .description("Rank user-provided JSONL candidates with pairwise judging.")
    .requiredOption("--task <path-or-inline>")
    .requiredOption("--candidates <jsonl>")
    .option("--rubric <path-or-inline>")
    .option("--config <yaml>")
    .option("--profile <profile>", "quick|balanced|paper")
    .option("--profile-name <name>", "Load saved bundle from ~/.config/deepthonk/profiles/<name>.yaml")
    .option("--provider <provider>", "fake|deepseek|openrouter|openai-compatible or any OpenAI-compatible alias")
    .option("--base-url <url>")
    .option("--api-key-env <name>")
    .option("--supports-json-mode <true|false>", "Whether the base OpenAI-compatible provider supports response_format JSON mode")
    .option("--judge-model <model>")
    .option("--request-timeout-ms <number>")
    .option("--judge-temperature <number>", "Temperature for pairwise judging")
    .option("--lambda <number>", "Bradley-Terry L2 regularization")
    .option("--concurrency <number>", "Maximum concurrent pairwise comparisons")
    .option("--prompt-style <style>", "general|paper-programming")
    .option("--prompts <yaml>", "YAML file with per-phase prompt overrides")
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
      const resolved = await resolveOneShotConfig(options);
      const result = await rankCandidates({
        task,
        rubric,
        candidates,
        driver: createDriver(resolved.providerConfig),
        judgeModel: resolved.models.judge,
        temperature: resolved.profile.judgeTemperature,
        lambda: resolved.profile.lambda,
        concurrency: numberOption(options.concurrency, "--concurrency", { integer: true, min: 1 }) ?? resolved.concurrency.judge,
        promptStyle: resolved.promptStyle,
        promptOverrides: resolved.promptOverrides?.compare ? { compare: resolved.promptOverrides.compare } : undefined
      });
      console.log(JSON.stringify(result.scores, null, 2));
    });
}
