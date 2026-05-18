import type { Command } from "commander";
import { runDeepThonk } from "@deepthonk/core";
import { createDriver } from "@deepthonk/providers";
import { resolveRunConfig } from "../config.js";

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("Run DeepThonk search.")
    .requiredOption("--task <path-or-inline>")
    .option("--rubric <path-or-inline>")
    .option("--config <yaml>")
    .option("--profile <profile>", "quick|balanced|paper")
    .option("--provider <provider>", "fake|deepseek|openrouter|openai-compatible or any OpenAI-compatible alias")
    .option("--base-url <url>")
    .option("--api-key-env <name>")
    .option("--generator-model <model>")
    .option("--mutator-model <model>")
    .option("--judge-model <model>")
    .option("--finalizer-model <model>")
    .option("--seed <number>")
    .option("--out <dir>")
    .option("--max-concurrency <number>")
    .option("--max-calls <number>")
    .option("--max-input-tokens <number>")
    .option("--max-output-tokens <number>")
    .option("--max-usd <number>")
    .option("--request-timeout-ms <number>")
    .option("--dry-run")
    .action(async (options) => {
      const resolved = await resolveRunConfig(options);
      if (options.dryRun) {
        console.log(JSON.stringify(redacted(withApiKeyPresence(resolved)), null, 2));
        return;
      }
      const result = await runDeepThonk(resolved.runConfig, createDriver(resolved.providerConfig));
      console.log(
        JSON.stringify(
          {
            run_id: result.runId,
            run_dir: result.runDir,
            winner_id: result.winner.id,
            calls: result.calls,
            final_answer: result.finalAnswer
          },
          null,
          2
        )
      );
    });
}

function redacted(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, inner) => {
      if (/^(apiKey|token|password|secret)$/i.test(key) && inner) return "[redacted]";
      return inner;
    })
  );
}

function withApiKeyPresence<T extends { providerConfig: { apiKeyEnv?: string; apiKey?: string } }>(value: T): T & { providerConfig: T["providerConfig"] & { apiKeyPresent: boolean } } {
  const apiKeyEnv = value.providerConfig.apiKeyEnv;
  return {
    ...value,
    providerConfig: {
      ...value.providerConfig,
      apiKeyPresent: Boolean(value.providerConfig.apiKey || (apiKeyEnv && process.env[apiKeyEnv]))
    }
  };
}
