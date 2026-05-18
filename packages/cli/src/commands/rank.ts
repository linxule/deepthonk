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
        judgeModel: resolved.models.judge
      });
      console.log(JSON.stringify(result.scores, null, 2));
    });
}
