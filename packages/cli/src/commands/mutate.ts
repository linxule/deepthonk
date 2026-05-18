import type { Command } from "commander";
import { mutateCandidate } from "@deepthonk/core";
import { createDriver } from "@deepthonk/providers";
import { readPathOrInline, resolveProviderOnlyConfig } from "../config.js";

export function registerMutate(program: Command): void {
  program
    .command("mutate")
    .description("Mutate one candidate with supplied critique.")
    .requiredOption("--task <path-or-inline>")
    .requiredOption("--candidate <path-or-inline>")
    .requiredOption("--critique <path-or-inline>")
    .option("--rubric <path-or-inline>")
    .option("--config <yaml>")
    .option("--provider <provider>", "fake|deepseek|openrouter|openai-compatible or any OpenAI-compatible alias")
    .option("--base-url <url>")
    .option("--api-key-env <name>")
    .option("--mutator-model <model>")
    .option("--json", "Print a structured JSON result.")
    .action(async (options) => {
      const [task, candidateText, critique, rubric] = await Promise.all([
        readPathOrInline(options.task),
        readPathOrInline(options.candidate),
        readPathOrInline(options.critique),
        options.rubric ? readPathOrInline(options.rubric) : undefined
      ]);
      const resolved = await resolveProviderOnlyConfig(options);
      const result = await mutateCandidate({
        task,
        rubric,
        candidate: { id: "user-candidate", content: candidateText },
        driver: createDriver(resolved.providerConfig),
        mutatorModel: resolved.models.mutator,
        temperature: 1,
        critique
      });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(result.mutated);
    });
}
