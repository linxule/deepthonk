import type { Command } from "commander";
import { mutateCandidate } from "@deepthonk/core";
import { createDriver } from "@deepthonk/providers";
import { readPathOrInline, resolveOneShotConfig } from "../config.js";

export function registerMutate(program: Command): void {
  program
    .command("mutate")
    .description("Mutate one candidate with supplied critique.")
    .requiredOption("--task <path-or-inline>")
    .requiredOption("--candidate <path-or-inline>")
    .requiredOption("--critique <path-or-inline>")
    .option("--rubric <path-or-inline>")
    .option("--config <yaml>")
    .option("--profile <profile>", "quick|balanced|paper")
    .option("--profile-name <name>", "Load saved bundle from ~/.config/deepthonk/profiles/<name>.yaml")
    .option("--provider <provider>", "fake|deepseek|openrouter|openai-compatible or any OpenAI-compatible alias")
    .option("--base-url <url>")
    .option("--api-key-env <name>")
    .option("--supports-json-mode <true|false>", "Whether the base OpenAI-compatible provider supports response_format JSON mode")
    .option("--mutator-model <model>")
    .option("--request-timeout-ms <number>")
    .option("--mutate-temperature <number>", "Temperature for mutation")
    .option("--prompt-style <style>", "general|paper-programming")
    .option("--prompts <yaml>", "YAML file with per-phase prompt overrides")
    .option("--prompts-json <json>", "Inline JSON object with a mutate prompt override")
    .option("--json", "Print a structured JSON result.")
    .action(async (options) => {
      const [task, candidateText, critique, rubric] = await Promise.all([
        readPathOrInline(options.task),
        readPathOrInline(options.candidate),
        readPathOrInline(options.critique),
        options.rubric ? readPathOrInline(options.rubric) : undefined
      ]);
      const resolved = await resolveOneShotConfig(options);
      const result = await mutateCandidate({
        task,
        rubric,
        candidate: { id: "user-candidate", content: candidateText },
        driver: createDriver(resolved.providerConfig),
        mutatorModel: resolved.models.mutator,
        temperature: resolved.profile.mutateTemperature,
        critique,
        promptStyle: resolved.promptStyle,
        promptOverrides: resolved.promptOverrides?.mutate ? { mutate: resolved.promptOverrides.mutate } : undefined
      });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(result.mutated);
    });
}
